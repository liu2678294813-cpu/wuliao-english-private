# Pronunciation audio credits — pipeline v2

All word audio and the 32 selected part-of-speech variants in this release are synthesized locally using [hexgrad/Kokoro-82M v1.0](https://huggingface.co/hexgrad/Kokoro-82M), fixed American English voice **af_heart**, speed **0.95**.

The model is [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Runtime [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) is MIT. These describe the model/software licenses; the manifest does not invent an independent copyright license for each synthetic utterance. Models and generation runtimes are not distributed with this website.

Selected heteronym variants use transcriptions from the [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict). Its BSD-style permission notice is included in `licenses/CMUdict-LICENSE.txt`, and each variant retains its source ARPABET transcription.

## Processing and quality boundary

Kokoro is invoked with `trim=False`. Every returned sample is retained. Processing consists of gain normalization, 40ms/80ms leading/trailing silence padding, and Ogg Vorbis encoding; reconstructed peaks are checked and attenuated when necessary. The manifest records raw/output sample counts, gain, padding and hashes. Raw FLOAT WAV checkpoints are retained locally for verification, not served by the site.

Full waveform retention prevents this processing pipeline from truncating model output. It does not establish that the model pronounced every phoneme correctly. Audio is synthetic; comprehensive human listening and accent/word-sense review have not been performed. A recorded source was investigated, but Commons downloads returned HTTP 429; no previously cropped Commons recording is reused in this v2 release.

`manifest.json` and `variants.json` contain per-file provenance. `validation.json` records automated signal and integrity checks; these are not a pronunciation-accuracy score.

## First-sense selection and audit

The 6515 default entries, 32 POS variant records and 20 retained base records reference **6547 unique Ogg files** (6567 records including shared default/variant paths). 20 default readings use verified first Chinese senses; remaining ambiguity is documented in [the 75-word text audit](docs/audit/README.md). Default entries retain the actual selected file provenance; original base provenance remains separately auditable. All 6547 files are synthetic; **Commons recording count is zero**. Local raw evidence: `D:/codex库/无聊英语发音素材/uncut-release/.raw/` (not deployed).
