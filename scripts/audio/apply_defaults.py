"""Apply reviewed dictionary-primary-sense defaults to a completed release.
Does not rewrite audio, raw WAVs or generation checkpoints.
"""
import argparse,json,pathlib

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',required=True)
    parser.add_argument('--words-file',required=True)
    parser.add_argument('--mapping-file',default=str(pathlib.Path(__file__).with_name('default-selections.json')))
    args=parser.parse_args();root=pathlib.Path(args.output_dir)
    manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    if len(manifest['entries'])!=manifest['uniqueWords']:raise ValueError('Apply defaults only after full generation is complete')
    variants=json.loads((root/'variants.json').read_text(encoding='utf-8'))
    config=json.loads(pathlib.Path(args.mapping_file).read_text(encoding='utf-8'))
    words={row['english'].strip().lower():row for row in json.loads(pathlib.Path(args.words_file).read_text(encoding='utf-8'))}
    for group in config.values():
        for word,selection in group.items():
            row=words[word]
            if row.get('wordId')!=selection['sourceWordId'] or row['chinese']!=selection['sourceChinese']:
                raise ValueError('Source meaning changed; review the default selection for '+word)
    audit=manifest.setdefault('basePronunciations',{})
    manifest['defaultPos']={}
    for word,selection in config['selected'].items():
        audit.setdefault(word,dict(manifest['entries'][word]))
        selected=dict(variants[word][selection['pos']])
        selected['defaultSelection']={'policy':'reviewed-dictionary-primary-sense',**selection}
        selected['heteronymReviewRequired']=True
        manifest['entries'][word]=selected
        manifest['defaultPos'][word]=selection['pos']
    for word,selection in config['ambiguous'].items():
        manifest['entries'][word]['defaultSelection']={'policy':'base-preserved-ambiguous',**selection}
        manifest['entries'][word]['heteronymReviewRequired']=True
    records=list(manifest['entries'].values())+[d for choices in variants.values() for d in choices.values()]+list(audit.values())
    manifest['pronunciationRecordCount']=len(records)
    manifest['uniqueAudioFiles']=len({d['path'] for d in records})
    temporary=root/'manifest.defaults.tmp'
    temporary.write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    temporary.replace(root/'manifest.json')
    print('selected',len(config['selected']),'dictionary defaults;',len(config['ambiguous']),'ambiguous bases retained;',len(records),'records;',manifest['uniqueAudioFiles'],'unique files')

if __name__=='__main__':
    main()
