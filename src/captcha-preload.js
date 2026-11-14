// captcha-preload.js
const seedStr = process.argv.find(arg => arg.startsWith('--seed=')) || '--seed=123';
const seed = parseInt(seedStr.split('=')[1], 10);

const cores = [4, 6, 8, 12, 16][seed % 5];
const memory = [4, 8, 16, 32][seed % 4];
const gpus = [
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)'
];
const gpu = gpus[seed % 4];

// Этот код выполнится в контексте страницы ДО загрузки сайта
const script = document.createElement('script');
script.textContent = `
  (function() {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${cores} });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => ${memory} });

    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function() {
      const imageData = origGetImageData.apply(this, arguments);
      if (imageData.data.length > 0) imageData.data[0] = (imageData.data[0] + ${seed % 255}) % 256;
      return imageData;
    };

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      const ctx = this.getContext('2d');
      if (ctx) {
        const data = ctx.getImageData(0, 0, this.width, this.height);
        data.data[0] = (data.data[0] + ${seed % 255}) % 256;
        ctx.putImageData(data, 0, 0);
      }
      return origToDataURL.apply(this, arguments);
    };

    const spoofGL = (proto) => {
      const getParameter = proto.getParameter;
      proto.getParameter = function(parameter) {
        if (parameter === 37445) return 'Google Inc. (NVIDIA)';
        if (parameter === 37446) return '${gpu}';
        return getParameter.apply(this, arguments);
      };
    };
    if (typeof WebGLRenderingContext !== 'undefined') spoofGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') spoofGL(WebGL2RenderingContext.prototype);
  })();
`;
document.documentElement.appendChild(script);