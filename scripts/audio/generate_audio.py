"""Build/cache American pronunciation assets. See README.md for exact usage.
The model is not downloaded automatically. No paid service or API is called.
"""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, html, io, json, pathlib, re, sys, time

ROOT = MODEL = SF = NP = None
VOICE = 'af_heart'
TRIM_POLICY = 'preserve'
AMBIGUOUS = set('abstract accent address advocate affect alternate associate attribute close compact compound compress conduct conflict console content contest contract contrast converse convict coordinate decrease defect delegate deliberate desert digest discharge discount document duplicate elaborate estimate excuse export extract frequent graduate house impact import incense increase insult intimate invalid lead live minute moderate object perfect permit present produce progress project protest read rebel record refuse reject resume separate subject suspect tear transfer transport upset use wind wound'.split())


def save_json(path, value):
    path = pathlib.Path(path)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temp.replace(path)


def init_worker(options):
    global ROOT, MODEL, SF, NP, VOICE, TRIM_POLICY
    ROOT = pathlib.Path(options['output_dir'])
    if options.get('runtime_dir'):
        sys.path.insert(0, options['runtime_dir'])
    import numpy as np
    import soundfile as sf
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    NP, SF, VOICE = np, sf, options['voice']
    TRIM_POLICY = options['trim_policy']
    if options.get('espeak_data_path'):
        # phonemizer's Path.resolve() undoes SUBST on Windows; retain the supplied
        # ASCII path for eSpeak, whose file API cannot handle Unicode paths.
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
        data_path = pathlib.Path(options['espeak_data_path'])
        if not (data_path / 'phontab').is_file():
            raise FileNotFoundError('espeak-data-path must contain phontab')
        EspeakWrapper.data_path = property(lambda self: data_path)
    ort.set_seed(20260916)
    opt = ort.SessionOptions()
    opt.intra_op_num_threads = options['threads']
    opt.inter_op_num_threads = 1
    session = ort.InferenceSession(options['model'], sess_options=opt,
                                   providers=['CPUExecutionProvider'])
    MODEL = Kokoro.from_session(session, options['voices'])


def normalize(audio, sample_rate):
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    active = NP.flatnonzero(NP.abs(audio) > max(.001, float(NP.max(NP.abs(audio))) * .006))
    if not len(active):
        raise ValueError('silent signal')
    if TRIM_POLICY == 'legacy':
        audio = audio[max(0, active[0] - int(sample_rate * .06)):
                      min(len(audio), active[-1] + int(sample_rate * .12))]
        level_window = audio
    else:
        # The threshold selects a level-measurement window ONLY. No input
        # samples are removed in the default preserve pipeline.
        level_window = audio[active[0]:active[-1] + 1]
    rms = float(NP.sqrt(NP.mean(level_window * level_window)))
    gain = min(.16 / max(rms, 1e-8), .89 / max(float(NP.max(NP.abs(audio))), 1e-8))
    retained = len(audio)
    audio = audio * gain
    return (NP.concatenate([NP.zeros(int(sample_rate * .04)), audio,
                            NP.zeros(int(sample_rate * .08))]).astype('float32'), gain, retained)


def write_audio(word, audio, sr, pos=None):
    key = hashlib.sha256((word + ('|' + pos if pos else '')).encode()).hexdigest()[:20]
    path = ROOT / 'audio' / (key + '.ogg')
    raw_path = ROOT / '.raw' / (key + '.wav')
    raw_path.parent.mkdir(exist_ok=True)
    SF.write(raw_path, audio, sr, format='WAV', subtype='FLOAT')
    raw_count = len(audio)
    audio, gain, retained = normalize(audio, sr)
    if not .15 <= len(audio) / sr <= 12:
        raise ValueError('duration outside accepted bounds')
    SF.write(path, audio, sr, format='OGG', subtype='VORBIS')
    decoded, rate = SF.read(path, dtype='float32')
    peak = float(NP.max(NP.abs(decoded)))
    correction = 1.
    if peak >= .99:
        correction = .8 / peak
        SF.write(path, decoded * correction, rate, format='OGG', subtype='VORBIS')
        decoded, rate = SF.read(path, dtype='float32')
        if float(NP.max(NP.abs(decoded))) >= .99:
            raise ValueError('post-encoding peak correction failed')
    return {'word': word, 'pos': pos, 'path': 'audio/' + path.name,
            'duration': round(len(audio) / sr, 3), 'sampleRate': sr,
            'rawSampleCount': raw_count, 'retainedRawSampleCount': retained,
            'outputSampleCount': len(decoded), 'trim': TRIM_POLICY != 'preserve',
            'trimPolicy': TRIM_POLICY, 'pipelineVersion': 2 if TRIM_POLICY == 'preserve' else 1,
            'normalizationGain': gain * correction, 'initialNormalizationGain': gain,
            'encodingPeakCorrectionGain': correction,
            'paddingSamples': {'leading': int(sr * .04), 'trailing': int(sr * .08)},
            'rawLocalPath': '.raw/' + raw_path.name,
            'rawSha256': hashlib.sha256(raw_path.read_bytes()).hexdigest(),
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def base_metadata(voice=None):
    voice = voice or VOICE
    return {'source': 'https://huggingface.co/hexgrad/Kokoro-82M',
            'license': 'Apache-2.0 (model)',
            'licenseUrl': 'https://www.apache.org/licenses/LICENSE-2.0',
            'attribution': 'Synthesized locally with hexgrad/Kokoro-82M v1.0, voice ' + voice + '; kokoro-onnx (MIT)',
            'generated': True, 'voice': voice, 'accent': 'en-US',
            'modifications': 'Preserved full inference waveform; normalized level; added 40ms/80ms silence; encoded Ogg Vorbis' if TRIM_POLICY == 'preserve' else 'Legacy threshold trimming; normalized level; encoded Ogg Vorbis',
            'qualityReview': 'automated-signal-check-only'}


def build_word(word):
    key = hashlib.sha256(word.encode()).hexdigest()[:20]
    checkpoint = ROOT / '.checkpoints' / (key + '.json')
    if checkpoint.is_file():
        try:
            old = json.loads(checkpoint.read_text(encoding='utf-8'))
            policy_matches = old.get('trimPolicy') == TRIM_POLICY
            published_matches = hashlib.sha256((ROOT / old['path']).read_bytes()).hexdigest() == old['sha256']
            raw_matches = (TRIM_POLICY != 'preserve' or
                           hashlib.sha256((ROOT / old['rawLocalPath']).read_bytes()).hexdigest() == old['rawSha256'])
            if policy_matches and published_matches and raw_matches:
                return None
        except (OSError, KeyError, ValueError):
            pass
    try:
        audio, sr = MODEL.create(word, voice=VOICE, speed=.95, lang='en-us', trim=TRIM_POLICY != 'preserve')
        entry = {**write_audio(word, audio, sr), **base_metadata(),
                 'heteronymReviewRequired': word in AMBIGUOUS}
        save_json(checkpoint, entry)
        return None
    except Exception as exc:
        return {'word': word, 'error': str(exc)}


def collect_recordings(config_path):
    import requests
    sources = json.loads(pathlib.Path(config_path).read_text(encoding='utf-8'))
    allowed = {'CC BY-SA 3.0', 'CC BY-SA 4.0', 'Public domain', 'CC0', 'CC BY 3.0'}
    for word, info in sources.items():
        checkpoint = ROOT / '.checkpoints' / (hashlib.sha256(word.encode()).hexdigest()[:20] + '.json')
        if checkpoint.is_file():
            continue
        meta = info['extmetadata']
        license_name = meta.get('LicenseShortName', {}).get('value')
        if license_name not in allowed:
            raise ValueError('Unapproved or unknown recording license: ' + str(license_name))
        response = requests.get(info['url'].split('?')[0], timeout=30,
                                headers={'User-Agent': 'WuliaoEnglishAudioResearch/1.0 (educational asset audit)'})
        if response.status_code == 429:
            print('Commons rate limited; stop recorded downloads and use local synthesis.', flush=True)
            break
        response.raise_for_status()
        audio, sr = SF.read(io.BytesIO(response.content), dtype='float32')
        entry = write_audio(word, audio, sr)
        entry.update({'source': info['descriptionurl'], 'license': license_name,
                      'licenseUrl': meta.get('LicenseUrl', {}).get('value'),
                      'attribution': html.unescape(re.sub('<[^>]+>', '', meta.get('Artist', {}).get('value', 'See source'))),
                      'generated': False, 'modifications': 'Preserved full inference waveform; normalized level; added 40ms/80ms silence; encoded Ogg Vorbis' if TRIM_POLICY == 'preserve' else 'Legacy threshold trimming; normalized level; encoded Ogg Vorbis'})
        save_json(checkpoint, entry)
        time.sleep(1)


def assemble(output, words):
    entries = {}
    for path in (output / '.checkpoints').glob('*.json'):
        entry = json.loads(path.read_text(encoding='utf-8'))
        if entry['word'] in words:
            entries[entry['word']] = entry
    manifest = {'version': 1, 'accent': 'en-US', 'voice': VOICE,
                'uniqueWords': len(words), 'covered': len(entries),
                'generated': sum(x['generated'] for x in entries.values()),
                'commons': sum(not x['generated'] for x in entries.values()),
                'missing': sorted(set(words) - set(entries)), 'entries': entries,
                'limitations': ['No exhaustive human pronunciation listening review.',
                                'Source dictionary lacks POS; unresolved heteronyms need context.',
                                'Private browser-imported word banks are not included.']}
    save_json(output / 'manifest.json', manifest)
    variants_path = output / 'variants.json'
    variants = json.loads(variants_path.read_text(encoding='utf-8')) if variants_path.is_file() else {}
    index = {'version': 2, 'accent': 'en-US', 'covered': len(entries), 'uniqueWords': len(words),
             'entries': {w: {'path': d['path'], 'revision': d['sha256'][:16]} for w, d in entries.items()},
             'variants': {w: {pos: {'path': d['path'], 'revision': d['sha256'][:16]} for pos, d in poss.items()} for w, poss in variants.items()},
             'credits': 'AUDIO-CREDITS.md', 'provenance': 'manifest.json'}
    save_json(output / 'index.json', index)
    return len(entries)


def main():
    global VOICE, MODEL
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--source-dir', help='Directory containing chunk_*.js')
    source.add_argument('--words-file', help='JSON array with english fields')
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--voices', required=True)
    parser.add_argument('--runtime-dir', help='Optional local pip --target directory')
    parser.add_argument('--espeak-data-path', help='Optional ASCII eSpeak data directory, containing phontab')
    parser.add_argument('--voice', default='af_heart')
    parser.add_argument('--trim-policy', choices=['preserve', 'legacy'], default='preserve',
                        help='preserve (default): trim=False, retain every inference sample; legacy reproduces old threshold trimming')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--recorded-sources', help='Optional explicitly licensed recorded source JSON')
    parser.add_argument('--variant-config', help='Optional selected phoneme variants JSON')
    args = parser.parse_args()
    VOICE = args.voice
    if args.workers < 1 or args.threads < 1:
        parser.error('workers and threads must be positive')
    output = pathlib.Path(args.output_dir).resolve()
    for folder in [output, output / 'audio', output / '.checkpoints', output / '.raw']:
        folder.mkdir(parents=True, exist_ok=True)
    if args.words_file:
        rows = json.loads(pathlib.Path(args.words_file).read_text(encoding='utf-8-sig'))
    else:
        rows = []
        pattern = r'wordId:`([^`]+)`,english:`([^`]+)`,chinese:`([^`]+)`'
        for path in sorted(pathlib.Path(args.source_dir).glob('chunk_*.js')):
            rows.extend(dict(zip(['wordId', 'english', 'chinese'], m.groups()))
                        for m in re.finditer(pattern, path.read_text(encoding='utf-8')))
    words = sorted({r['english'].strip().lower() for r in rows if r.get('english', '').strip()})
    if not words:
        raise ValueError('No vocabulary entries found')
    save_json(output / 'words.json', rows)
    # Existing deployment is a valid cache, even without build checkpoints.
    if (output / 'manifest.json').is_file():
        old = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
        for word, entry in old.get('entries', {}).items():
            entry = old.get('basePronunciations', {}).get(word, entry)
            key = hashlib.sha256(word.encode()).hexdigest()[:20]
            save_json(output / '.checkpoints' / (key + '.json'), entry)
    options = vars(args).copy()
    options['output_dir'] = str(output)
    if args.recorded_sources or args.variant_config:
        init_worker(options)
        if args.recorded_sources:
            try:
                collect_recordings(args.recorded_sources)
            except Exception as exc:
                print('Recorded source unavailable; local synthesis will fill gaps:', str(exc), flush=True)
        if args.variant_config:
            variants = {}
            config = json.loads(pathlib.Path(args.variant_config).read_text(encoding='utf-8'))
            for word, choices in config.items():
                variants[word] = {}
                for pos, choice in choices.items():
                    voice = choice.get('voice', VOICE)
                    audio, sr = MODEL.create(choice['phonemes'], voice=voice, speed=.95, is_phonemes=True, trim=TRIM_POLICY != 'preserve')
                    variants[word][pos] = {**write_audio(word, audio, sr, pos), **base_metadata(voice),
                                           **choice, 'qualityReview': 'dictionary-phoneme-and-automated-signal-check; not human-listened'}
            save_json(output / 'variants.json', variants)
    MODEL = None
    import gc
    gc.collect()
    failures = []
    started = time.time()
    with concurrent.futures.ProcessPoolExecutor(args.workers, initializer=init_worker, initargs=(options,)) as pool:
        for index, result in enumerate(pool.map(build_word, words, chunksize=10)):
            if result:
                failures.append(result)
            if index % 100 == 0:
                print('covered', assemble(output, words), '/', len(words), 'elapsed', round(time.time() - started), flush=True)
    print('complete', assemble(output, words), '/', len(words), flush=True)
    save_json(output / 'errors.json', failures)
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()


