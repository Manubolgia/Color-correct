// Bundles the parts of Mediabunny the app uses into one ES module: app/vendor/mediabunny.js
// Run: npm install && npm run vendor
import { build } from 'esbuild';
import { copyFileSync, readFileSync } from 'fs';

const entry = `export {
  Input, Output, BlobSource, StreamTarget, Mp4OutputFormat, MP4, QTFF, Quality,
  VideoSampleSink, getFirstEncodableVideoCodec,
  CustomVideoDecoder, registerDecoder, VideoSample, EncodedPacketSink, EncodedAudioPacketSource, VideoSampleSource
} from 'mediabunny';`;

const version = JSON.parse(readFileSync(new URL('./node_modules/mediabunny/package.json', import.meta.url))).version;
await build({
  stdin: { contents: entry, resolveDir: new URL('.', import.meta.url).pathname },
  bundle: true, format: 'esm', minify: true, target: 'es2022', platform: 'browser',
  outfile: new URL('../app/vendor/mediabunny.js', import.meta.url).pathname,
  banner: { js: `/* Mediabunny ${version} (MPL-2.0) https://github.com/Vanilagy/mediabunny - source: https://www.npmjs.com/package/mediabunny/v/${version} */` },
  legalComments: 'none'
});
copyFileSync(new URL('./node_modules/mediabunny/LICENSE', import.meta.url), new URL('../app/vendor/MEDIABUNNY-LICENSE.txt', import.meta.url));
console.log('built mediabunny', version);
