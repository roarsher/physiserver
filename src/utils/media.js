import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';

const IMAGE_LIMIT = 5 * 1024 * 1024;
const VIDEO_LIMIT = 50 * 1024 * 1024;

function configureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  if (!cloudName || !apiKey || !apiSecret) {
    throw Object.assign(
      new Error('Cloudinary is not configured on the server.'),
      { status: 503 }
    );
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  return cloudinary;
}

export async function inspectMedia(
  file,
  { imageOnly = false } = {}
) {
  if (!file?.buffer) {
    throw Object.assign(new Error('Choose a file'), {
      status: 400,
    });
  }

  const type = await fileTypeFromBuffer(file.buffer);

  const images = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ];

  const videos = ['video/mp4', 'video/webm'];

  const isImage = type && images.includes(type.mime);
  const isVideo = type && videos.includes(type.mime);

  if (!isImage && (!isVideo || imageOnly)) {
    throw Object.assign(
      new Error(
        imageOnly
          ? 'Use a JPEG, PNG, WebP or GIF image'
          : 'Use a JPEG, PNG, WebP, GIF, MP4 or WebM file'
      ),
      { status: 400 }
    );
  }

  if (isImage) {
    if (file.buffer.length > IMAGE_LIMIT) {
      throw Object.assign(
        new Error('Images must not exceed 5 MB'),
        { status: 400 }
      );
    }

    try {
      const buffer = await sharp(file.buffer, {
        limitInputPixels: 40000000,
      })
        .rotate()
        .resize({
          width: imageOnly ? 1000 : 1800,
          height: imageOnly ? 1000 : 1800,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toBuffer();

      return {
        buffer,
        mime: 'image/webp',
        ext: 'webp',
        kind: 'image',
      };
    } catch {
      throw Object.assign(
        new Error('The image cannot be read'),
        { status: 400 }
      );
    }
  }

  if (file.buffer.length > VIDEO_LIMIT) {
    throw Object.assign(
      new Error('Videos must not exceed 50 MB'),
      { status: 400 }
    );
  }

  return {
    buffer: file.buffer,
    mime: type.mime,
    ext: type.ext,
    kind: 'video',
  };
}

export async function saveMedia(media) {
  const client = configureCloudinary();

  const uploaded = await new Promise((resolve, reject) => {
    const stream = client.uploader.upload_stream(
      {
        resource_type: media.kind,
        public_id: `abhi-physiotherapy/gallery/${randomUUID()}`,
        overwrite: false,
        timeout: 120000,
      },
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload failed:', {
            code: error.http_code,
            message: error.message,
          });

          reject(
            Object.assign(
              new Error(
                'Media upload failed. Please try again.'
              ),
              { status: 502 }
            )
          );

          return;
        }

        if (!result?.secure_url || !result?.public_id) {
          reject(
            Object.assign(
              new Error('Media upload returned an invalid response.'),
              { status: 502 }
            )
          );

          return;
        }

        resolve(result);
      }
    );

    stream.on('error', reject);
    stream.end(media.buffer);
  });

  return {
    storage: 'cloudinary',
    url: uploaded.secure_url,
    publicId: uploaded.public_id,
    resourceType: uploaded.resource_type,
    fileName: '',
  };
}

export function getMediaUrl(item) {
  if (item?.storage === 'cloudinary') {
    return item.url || '';
  }

  // Compatibility with existing local uploads.
  return item?.fileName
    ? `/uploads/${item.fileName}`
    : '';
}

export async function removeMedia(item, directory) {
  if (!item) return;

  if (item.storage === 'cloudinary') {
    if (
      !item.publicId ||
      !['image', 'video'].includes(item.resourceType)
    ) {
      throw new Error('Invalid Cloudinary media metadata');
    }

    const client = configureCloudinary();

    const result = await client.uploader.destroy(
      item.publicId,
      {
        resource_type: item.resourceType,
        invalidate: true,
      }
    );

    if (!['ok', 'not found'].includes(result.result)) {
      throw new Error('Unable to delete Cloudinary media');
    }

    return;
  }

  // Compatibility with existing local uploads.
  const fileName =
    typeof item === 'string' ? item : item.fileName;

  if (
    !directory ||
    typeof fileName !== 'string' ||
    !/^[\da-f-]+\.(webp|mp4|webm)$/.test(fileName)
  ) {
    return;
  }

  try {
    await unlink(path.join(directory, fileName));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}