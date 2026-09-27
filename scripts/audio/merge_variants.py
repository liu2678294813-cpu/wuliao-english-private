"""Merge extra generated variants after the destination generator has stopped."""
import argparse,hashlib,json,pathlib,shutil
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output-dir',required=True);p.add_argument('--extras',nargs='+',required=True)
a=p.parse_args();out=pathlib.Path(a.output_dir)
variants=json.loads((out/'variants.json').read_text(encoding='utf8'))
for folder in a.extras:
 root=pathlib.Path(folder)
 for word,choices in json.loads((root/'variants.json').read_text(encoding='utf8')).items():
  for pos,entry in choices.items():
   if entry.get('trim') is not False or entry.get('pipelineVersion')!=2:raise ValueError('Only pipeline2 full-wave variants may be merged')
   for field,digest in [('path','sha256'),('rawLocalPath','rawSha256')]:
    src=root/entry[field];dest=out/entry[field]
    if not src.resolve().is_relative_to(root.resolve()) or not dest.resolve().is_relative_to(out.resolve()):raise ValueError('Invalid asset path')
    if hashlib.sha256(src.read_bytes()).hexdigest()!=entry[digest]:raise ValueError('Source hash mismatch')
    dest.parent.mkdir(parents=True,exist_ok=True)
    if src.resolve()!=dest.resolve():shutil.copy2(src,dest)
   variants.setdefault(word,{})[pos]=entry
path=out/'variants.json';temp=path.with_suffix('.merge.tmp');temp.write_text(json.dumps(variants,ensure_ascii=False,separators=(',',':')),encoding='utf8');temp.replace(path)
print(json.dumps({'words':len(variants),'variants':sum(len(c) for c in variants.values())}))
