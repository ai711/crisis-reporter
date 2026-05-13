export interface CompressionResult {
  file: File;
  compressed: boolean;
  original_size_kb: number;
  compressed_size_kb: number;
}

export async function compressPhoto(file: File): Promise<CompressionResult> {
  const original_size_kb = Math.round(file.size / 1024);

  // Under 1.5 MB — send as-is
  if (file.size < 1.5 * 1024 * 1024) {
    return { file, compressed: false, original_size_kb, compressed_size_kb: original_size_kb };
  }

  // Target: ~1 MB for 1.5–8 MB files, ~1.5 MB for files above 8 MB
  const targetQuality = file.size > 8 * 1024 * 1024 ? 0.88 : 0.82;

  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
      "image/jpeg",
      targetQuality
    );
  });

  const compressed_size_kb = Math.round(blob.size / 1024);
  const compressedFile = new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
    type: "image/jpeg",
  });

  return { file: compressedFile, compressed: true, original_size_kb, compressed_size_kb };
}
