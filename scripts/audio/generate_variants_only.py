"""Generate only configured POS variants into an isolated output directory."""
import argparse,json,pathlib
import generate_audio as g
p=argparse.ArgumentParser(description=__doc__)
for name in ['output-dir','model','voices','variant-config']:
 p.add_argument('--'+name,required=True)
p.add_argument('--runtime-dir');p.add_argument('--espeak-data-path')
p.add_argument('--voice',default='af_heart');p.add_argument('--threads',type=int,default=2)
p.add_argument('--trim-policy',choices=['preserve'],default='preserve')
a=p.parse_args();out=pathlib.Path(a.output_dir)
for folder in [out,out/'audio',out/'.raw']:folder.mkdir(parents=True,exist_ok=True)
g.init_worker(vars(a));result={}
for word,choices in json.loads(pathlib.Path(a.variant_config).read_text(encoding='utf8')).items():
 result[word]={}
 for pos,choice in choices.items():
  voice=choice.get('voice',a.voice)
  audio,sr=g.MODEL.create(choice['phonemes'],voice=voice,speed=.95,is_phonemes=True,trim=False)
  result[word][pos]={**g.write_audio(word,audio,sr,pos),**g.base_metadata(voice),**choice,'qualityReview':'dictionary-phoneme-and-automated-signal-check; not human-listened'}
  print(word,pos,flush=True)
g.save_json(out/'variants.json',result)
