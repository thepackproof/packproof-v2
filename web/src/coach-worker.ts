/// <reference lib="webworker" />
// Heuristics are advisory only; never part of capture eligibility or evidence.
self.onmessage = (event: MessageEvent<{ pixels: Uint8ClampedArray; width: number; height: number }>) => {
  const { pixels, width, height } = event.data;
  const gray = new Float32Array(width * height);
  let brightness = 0;
  for (let i = 0; i < gray.length; i++) { gray[i] = .2126 * pixels[i*4] + .7152 * pixels[i*4+1] + .0722 * pixels[i*4+2]; brightness += gray[i]; }
  let edges = 0;
  for (let y = 1; y < height-1; y++) for (let x = 1; x < width-1; x++) { const i=y*width+x; edges += Math.abs(gray[i-1]+gray[i+1]+gray[i-width]+gray[i+width]-4*gray[i]); }
  self.postMessage({ brightness: brightness / gray.length, detail: edges / ((width-2)*(height-2)) });
};
export {};
