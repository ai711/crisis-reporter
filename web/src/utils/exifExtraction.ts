import exifr from "exifr";

export interface ExifData {
  // Date/time
  DateTimeOriginal?: string;
  CreateDate?: string;
  ModifyDate?: string;
  // GPS
  latitude?: number;
  longitude?: number;
  GPSAltitude?: number;
  // Device/camera
  Make?: string;
  Model?: string;
  Software?: string;
  // Image properties
  ImageWidth?: number;
  ImageHeight?: number;
  Orientation?: number;
  ColorSpace?: number;
  // Camera settings
  ExposureTime?: number;
  FNumber?: number;
  ISO?: number;
  Flash?: number;
  FocalLength?: number;
  WhiteBalance?: number;
}

export async function extractExif(file: File): Promise<ExifData> {
  try {
    const data = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      interop: false,
      translateValues: false,
    });
    if (!data) return {};
    return {
      DateTimeOriginal: data.DateTimeOriginal?.toISOString?.() ?? undefined,
      CreateDate: data.CreateDate?.toISOString?.() ?? undefined,
      ModifyDate: data.ModifyDate?.toISOString?.() ?? undefined,
      latitude: data.latitude,
      longitude: data.longitude,
      GPSAltitude: data.GPSAltitude,
      Make: data.Make,
      Model: data.Model,
      Software: data.Software,
      ImageWidth: data.ImageWidth ?? data.ExifImageWidth,
      ImageHeight: data.ImageHeight ?? data.ExifImageHeight,
      Orientation: data.Orientation,
      ColorSpace: data.ColorSpace,
      ExposureTime: data.ExposureTime,
      FNumber: data.FNumber,
      ISO: data.ISO,
      Flash: data.Flash,
      FocalLength: data.FocalLength,
      WhiteBalance: data.WhiteBalance,
    };
  } catch {
    return {}; // Absent EXIF is not an error
  }
}
