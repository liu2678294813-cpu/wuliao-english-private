"""Fast regression tests: preserve quiet initial/final signal, sample accounting.
Run with Python environment containing numpy/soundfile; no model required.
"""
import importlib.util, os, pathlib, tempfile, unittest, hashlib
runtime = os.environ.get('AUDIO_RUNTIME_DIR')
if runtime:
    import sys
    sys.path.insert(0, runtime)
import numpy as np
import soundfile as sf
spec = importlib.util.spec_from_file_location('generate_audio', pathlib.Path(__file__).with_name('generate_audio.py'))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
generator.NP, generator.SF = np, sf


class PreserveWaveformTests(unittest.TestCase):
    def setUp(self):
        generator.TRIM_POLICY = 'preserve'
        self.sr = 24000
        quiet = np.full(6000, .0001, dtype='float32')
        loud = (.2 * np.sin(np.arange(12000, dtype='float32') * .12)).astype('float32')
        self.raw = np.concatenate([quiet, loud, -quiet])

    def test_weak_edges_are_retained_and_input_is_not_mutated(self):
        original = self.raw.copy()
        result, gain, retained = generator.normalize(self.raw, self.sr)
        self.assertEqual(retained, len(original))
        self.assertEqual(len(result), len(original) + 960 + 1920)
        np.testing.assert_array_equal(self.raw, original)
        np.testing.assert_allclose(result[960:960 + len(original)], original * gain, rtol=1e-6, atol=1e-9)
        self.assertGreater(float(result[960]), 0.)
        self.assertLess(float(result[960 + len(original) - 1]), 0.)

    def test_published_sample_count_and_raw_checkpoint(self):
        parent = pathlib.Path(__file__).parent / '.test-output'
        parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as folder:
            generator.ROOT = pathlib.Path(folder)
            (generator.ROOT / 'audio').mkdir()
            entry = generator.write_audio('test', self.raw, self.sr)
            raw, raw_rate = sf.read(generator.ROOT / entry['rawLocalPath'], dtype='float32')
            output, rate = sf.read(generator.ROOT / entry['path'], dtype='float32')
            self.assertEqual(raw_rate, self.sr)
            self.assertEqual(rate, self.sr)
            np.testing.assert_array_equal(raw, self.raw)
            self.assertFalse(entry['trim'])
            self.assertEqual(entry['rawSampleCount'], len(self.raw))
            self.assertEqual(entry['retainedRawSampleCount'], len(self.raw))
            self.assertEqual(entry['outputSampleCount'], len(output))
            self.assertEqual(len(output), len(raw) + sum(entry['paddingSamples'].values()))
            self.assertLess(float(np.max(np.abs(output))), .99)
            (generator.ROOT / '.checkpoints').mkdir()
            checkpoint = generator.ROOT / '.checkpoints' / (hashlib.sha256(b'test').hexdigest()[:20] + '.json')
            generator.save_json(checkpoint, entry)
            generator.MODEL = object()  # No inference method: a valid cache must not synthesize.
            self.assertIsNone(generator.build_word('test'))
        parent.rmdir()

    def test_legacy_is_explicit_not_default(self):
        generator.TRIM_POLICY = 'legacy'
        _, _, retained = generator.normalize(self.raw, self.sr)
        self.assertLess(retained, len(self.raw))


if __name__ == '__main__':
    unittest.main()
