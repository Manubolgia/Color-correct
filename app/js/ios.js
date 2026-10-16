/*
  iOS re-encodes every video picked from the Photos library before the page gets it (WebKit hands over
  a fresh .MOV export), and that can cut the frame rate: an 8:7 4K60 GoPro clip arrives at 15 fps.
  Clips picked through Files arrive untouched.
*/
export var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function looksReencoded(f) {
  if (!/\.mov$/i.test(f.name)) return false;
  if (/^(GX|GH|GS|GOPR|GP)\d/i.test(f.name)) return true; // GoPro never writes .MOV
  return isIOS && /\.MOV$/.test(f.name) && Date.now() - f.lastModified < 15 * 60e3;
}
