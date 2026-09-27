"""Build a lightweight playback index from immutable completed manifests."""
import argparse,json,pathlib

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',required=True)
    args=parser.parse_args()
    root=pathlib.Path(args.output_dir)
    manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    variants=json.loads((root/'variants.json').read_text(encoding='utf-8')) if (root/'variants.json').is_file() else {}
    def playback(entry):
        return {'path':entry['path'],'revision':entry['sha256'][:16]}
    index={'version':2,'accent':manifest.get('accent','en-US'),'covered':len(manifest['entries']),
           'uniqueWords':manifest['uniqueWords'],'entries':{word:playback(entry) for word,entry in manifest['entries'].items()},
           'variants':{word:{pos:playback(entry) for pos,entry in choices.items()} for word,choices in variants.items()},
           'defaultPos':manifest.get('defaultPos',{}),'credits':'AUDIO-CREDITS.md','provenance':'manifest.json'}
    temporary=root/'index.build.tmp'
    temporary.write_text(json.dumps(index,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    temporary.replace(root/'index.json')
    print('indexed',index['covered'],'words;',sum(len(p) for p in variants.values()),'variants; all entries include content revision')

if __name__=='__main__':
    main()
