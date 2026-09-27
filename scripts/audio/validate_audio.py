"""Validate an audio deployment; optionally repair Vorbis peak overshoot."""
import argparse, datetime, hashlib, json, pathlib, statistics, sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--runtime-dir')
    parser.add_argument('--repair-peaks', action='store_true')
    parser.add_argument('--require-raw', action='store_true', help='Require locally retained raw FLOAT WAV checkpoints')
    parser.add_argument('--allow-partial', action='store_true', help='Audit a generation snapshot without requiring full dictionary coverage')
    args = parser.parse_args()
    if args.runtime_dir:
        sys.path.insert(0, args.runtime_dir)
    import numpy as np
    import soundfile as sf
    root = pathlib.Path(args.output_dir).resolve()
    manifest_snapshot = (root / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_snapshot.decode('utf-8'))
    variants_path = root / 'variants.json'
    variants_snapshot = variants_path.read_bytes() if variants_path.is_file() else b'{}'
    variants = json.loads(variants_snapshot.decode('utf-8'))
    variant_records = [d for choices in variants.values() for d in choices.values()]
    base_records = list(manifest.get('basePronunciations', {}).values())
    records = list(manifest['entries'].values()) + variant_records + base_records
    unique = {}
    for entry in records:
        if entry['path'] in unique and unique[entry['path']]['sha256'] != entry['sha256']:
            raise ValueError('Conflicting hashes for the same published path')
        unique.setdefault(entry['path'], entry)
    entries = list(unique.values())
    issues, repairs, durations, peaks = [], [], [], []
    total_bytes = 0
    raw_verified = 0
    correlations = []
    preservation_verified = 0
    for position, entry in enumerate(entries):
        if position and position % 500 == 0:
            print("checked", position, "/", len(entries), flush=True)
        try:
            path = (root / entry['path']).resolve()
            if not path.is_relative_to(root / 'audio'):
                raise ValueError('path outside audio directory')
            if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
                raise ValueError('SHA256 mismatch')
            audio, sample_rate = sf.read(path, dtype='float32')
            peak = float(np.max(np.abs(audio)))
            if args.repair_peaks and peak >= .99:
                correction = .8 / peak
                sf.write(path, audio * correction, sample_rate, format='OGG', subtype='VORBIS')
                if 'normalizationGain' in entry:
                    entry['normalizationGain'] *= correction
                    entry['encodingPeakCorrectionGain'] = entry.get('encodingPeakCorrectionGain', 1.) * correction
                audio, sample_rate = sf.read(path, dtype='float32')
                peak = float(np.max(np.abs(audio)))
                entry['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                entry['postEncodingPeakCorrection'] = True
                repairs.append({'word': entry['word'], 'pos': entry.get('pos')})
            if entry.get('pipelineVersion') == 2:
                pads = entry['paddingSamples']
                expected_count = entry['rawSampleCount'] + pads['leading'] + pads['trailing']
                if entry.get('trim') is not False or entry['retainedRawSampleCount'] != entry['rawSampleCount']:
                    raise ValueError('raw waveform samples were removed')
                if entry['outputSampleCount'] != len(audio) or len(audio) != expected_count:
                    raise ValueError('output sample count does not equal raw plus padding')
                if sample_rate != entry['sampleRate']:
                    raise ValueError('sample rate mismatch')
                preservation_verified += 1
                raw_path = (root / entry['rawLocalPath']).resolve()
                if not raw_path.is_relative_to(root / '.raw'):
                    raise ValueError('raw path outside checkpoint directory')
                if raw_path.is_file():
                    if hashlib.sha256(raw_path.read_bytes()).hexdigest() != entry['rawSha256']:
                        raise ValueError('raw SHA256 mismatch')
                    raw, raw_rate = sf.read(raw_path, dtype='float32')
                    if raw_rate != sample_rate or len(raw) != entry['rawSampleCount']:
                        raise ValueError('raw checkpoint sample count or rate mismatch')
                    if raw.ndim == 1:
                        reconstructed = audio[pads['leading']:pads['leading'] + len(raw)]
                        corr = float(np.corrcoef(raw, reconstructed)[0, 1])
                        correlations.append({'word': entry['word'], 'pos': entry.get('pos'), 'correlation': corr})
                        if not np.isfinite(corr) or corr < .9:
                            raise ValueError('decoded signal differs substantially from complete raw waveform')
                    raw_verified += 1
                elif args.require_raw:
                    raise ValueError('raw checkpoint missing')
            elif args.require_raw:
                raise ValueError('asset does not use preservation pipeline version 2')
            duration = len(audio) / sample_rate
            rms = float(np.sqrt(np.mean(audio * audio)))
            if not .15 <= duration <= 12:
                raise ValueError('duration outside .15–12 seconds')
            if rms < .005:
                raise ValueError('near-silent signal')
            if peak >= .99:
                raise ValueError('Vorbis decoded signal exceeds .99 peak limit')
            if abs(duration - entry['duration']) > .02:
                raise ValueError('duration does not match manifest')
            durations.append(duration)
            peaks.append(peak)
            total_bytes += path.stat().st_size
        except Exception as exc:
            issues.append({'word': entry['word'], 'pos': entry.get('pos'), 'issue': str(exc)})
    if args.repair_peaks:
        for record in records:
            canonical = unique[record['path']]
            for field in ['sha256', 'normalizationGain', 'encodingPeakCorrectionGain', 'postEncodingPeakCorrection']:
                if field in canonical:
                    record[field] = canonical[field]
        (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        variants_path.write_text(json.dumps(variants, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        manifest_snapshot = (root / 'manifest.json').read_bytes()
        variants_snapshot = variants_path.read_bytes()
        # Keep optional build checkpoints in step with the deployment.
        for folder in [root / '.checkpoints', root / 'entries']:
            if folder.is_dir():
                for entry in manifest['entries'].values():
                    entry = manifest.get('basePronunciations', {}).get(entry['word'], entry)
                    checkpoint = folder / (hashlib.sha256(entry['word'].encode()).hexdigest()[:20] + '.json')
                    if checkpoint.is_file():
                        checkpoint.write_text(json.dumps(entry, ensure_ascii=False), encoding='utf-8')
    report = {'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'manifestSha256': hashlib.sha256(manifest_snapshot).hexdigest(),
              'variantsSha256': hashlib.sha256(variants_snapshot).hexdigest(),
              'uniqueWords': manifest['uniqueWords'], 'coveredWords': len(manifest['entries']),
              'coverageComplete': len(manifest['entries']) == manifest['uniqueWords'],
              'variants': len(variant_records), 'retainedBasePronunciations': len(base_records),
              'recordCount': len(records), 'uniqueAudioFiles': len(entries), 'verifiedFiles': len(durations),
              'totalBytes': total_bytes, 'generatedWords': sum(d['generated'] for d in manifest['entries'].values()),
              'commonsWords': sum(not d['generated'] for d in manifest['entries'].values()),
              'minDuration': min(durations, default=None), 'maxDuration': max(durations, default=None),
              'medianDuration': statistics.median(durations) if durations else None,
              'maxPeak': max(peaks, default=None), 'repairs': repairs, 'issues': issues,
              'humanListeningReview': False, 'privateImportedWordBanksIncluded': False,
              'fullWaveformSampleCountsVerified': preservation_verified, 'rawCheckpointsVerified': raw_verified,
              'minimumRawToDecodedCorrelation': min((x['correlation'] for x in correlations), default=None),
              'lowestRawToDecodedCorrelations': sorted(correlations, key=lambda x: x['correlation'])[:10],
              'signalCheckLimit': 'Sample-count and waveform correlation checks establish preservation of inference audio; they do not prove the model pronounced every phoneme correctly.'}
    if not args.allow_partial and len(manifest['entries']) != manifest['uniqueWords']:
        issues.append({'issue': 'incomplete vocabulary coverage'})
    (root / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if issues:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
