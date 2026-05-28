const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateIcon(size, outputPath) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0468B1';
  ctx.fillRect(0, 0, size, size);

  // White shield shape (simplified)
  const cx = size / 2;
  const cy = size / 2;
  const scale = size / 192;

  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  // Shield path scaled to icon size
  const s = scale * 60;
  ctx.moveTo(cx, cy - s * 1.1);
  ctx.lineTo(cx + s, cy - s * 0.5);
  ctx.lineTo(cx + s, cy + s * 0.3);
  ctx.quadraticCurveTo(cx + s, cy + s * 1.0, cx, cy + s * 1.2);
  ctx.quadraticCurveTo(cx - s, cy + s * 1.0, cx - s, cy + s * 0.3);
  ctx.lineTo(cx - s, cy - s * 0.5);
  ctx.closePath();
  ctx.fill();

  // Blue CR text in center
  ctx.fillStyle = '#0468B1';
  ctx.font = `bold ${Math.round(scale * 40)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('CR', cx, cy + scale * 4);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated ${outputPath}`);
}

const publicDir = path.join(__dirname, '..', 'public');
generateIcon(192, path.join(publicDir, 'pwa-192x192.png'));
generateIcon(512, path.join(publicDir, 'pwa-512x512.png'));
