"""Package only validated public assets; exclude models, raw audio and checkpoints."""
import argparse,hashlib,json,pathlib,zipfile

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',required=True)
    parser.add_argument('--zip-path',required=True)
    args=parser.parse_args()
    root=pathlib.Path(args.output_dir).resolve();archive=pathlib.Path(args.zip_path).resolve()
    manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    variants=json.loads((root/'variants.json').read_text(encoding='utf-8'))
    index=json.loads((root/'index.json').read_text(encoding='utf-8'))
    report=json.loads((root/'validation.json').read_text(encoding='utf-8'))
    records=list(manifest['entries'].values())+[d for p in variants.values() for d in p.values()]+list(manifest.get('basePronunciations',{}).values())
    entries=list({d['path']:d for d in records}.values())
    if report.get('manifestSha256')!=hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest() or report.get('variantsSha256')!=hashlib.sha256((root/'variants.json').read_bytes()).hexdigest():
        raise ValueError('validation report does not match current immutable manifests')
    if report['issues'] or report['coveredWords']!=manifest['uniqueWords'] or report['verifiedFiles']!=len(entries):
        raise ValueError('A complete successful validation report is required')
    for word,entry in manifest['entries'].items():
        if index['entries'][word]['revision']!=entry['sha256'][:16]:raise ValueError('stale index')
    for word,choices in variants.items():
        for pos,entry in choices.items():
            if index['variants'][word][pos]['revision']!=entry['sha256'][:16]:raise ValueError('stale variant index')
    paths={root/d['path'] for d in entries}
    for p in paths:
        if not p.resolve().is_relative_to(root/'audio'):raise ValueError('audio path outside release')
    paths.update(root/n for n in ['index.json','manifest.json','variants.json','AUDIO-CREDITS.md','model-info.json','validation.json'])
    paths.update(p for p in (root/'licenses').rglob('*') if p.is_file())
    paths.update(p for p in (root/'docs'/'audit').rglob('*') if p.is_file())
    archive.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as output:
        for p in sorted(paths):
            output.write(p,p.relative_to(root).as_posix(),compress_type=zipfile.ZIP_STORED if p.suffix=='.ogg' else zipfile.ZIP_DEFLATED)
    with zipfile.ZipFile(archive) as packed:
        if packed.testzip() is not None:raise ValueError('archive CRC validation failed')
    sha=hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix+'.sha256').write_text(sha+'  '+archive.name+'\n',encoding='ascii')
    print(json.dumps({'path':str(archive),'files':len(paths),'bytes':archive.stat().st_size,'sha256':sha},ensure_ascii=False))

if __name__=='__main__':
    main()
