 import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';

import {
  inspectMedia,
  saveMedia,
  removeMedia,
  getMediaUrl,
} from '../utils/media.js';

import { toCsv } from '../utils/csv.js';

const id = z.string().regex(/^[a-f\d]{24}$/i);

export const querySchema = z
  .object({
    status: z
      .enum([
        'new',
        'contacted',
        'closed',
        'pending',
        'approved',
        'rejected',
      ])
      .optional(),

    q: z.string().trim().max(120).optional(),

    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(value => !Number.isNaN(Date.parse(value)))
      .optional(),

    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(value => !Number.isNaN(Date.parse(value)))
      .optional(),

    page: z.coerce.number().int().min(1).default(1),

    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20),
  })
  .strict();

export function parse(schema, value) {
  const result = schema.safeParse(value);

  if (!result.success) {
    const details = result.error.issues.map(issue => {
      const field = issue.path.length
        ? issue.path.join('.')
        : 'Form';

      return `${field}: ${issue.message}`;
    });

    const error = new Error(details.join(' | '));
    error.status = 400;

    throw error;
  }

  return result.data;
}

const mediaView = row => {
  const item = row.toObject?.() || row;

  return {
    ...item,
    url: getMediaUrl(item),
  };
};

export function websiteRoutes({
  store,
  services,
  adminGuard,
  uploadDir,
  secret,
  ready,
}) {
  const router = Router();

  const uploadImage = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
      fields: 8,
    },
  }).single('image');

  const uploadGallery = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 1,
      fields: 8,
    },
  }).single('file');

  const available = (req, res, next) => {
    if (ready()) {
      return next();
    }

    return res.status(503).json({
      success: false,
      message: 'The website database is temporarily unavailable',
    });
  };

  // Public settings
  router.get('/settings', available, async (req, res) => {
    res.json({
      success: true,
      data: await store.getSettings(),
    });
  });

  // Public gallery
  router.get('/gallery', available, async (req, res) => {
    const items = await store.listGallery();

    res.json({
      success: true,
      data: items.map(mediaView),
    });
  });

  // Approved public reviews
  router.get('/reviews', available, async (req, res) => {
    const query = parse(querySchema, {
      ...req.query,
      status: 'approved',
    });

    const result = await store.listReviews(query);

    res.json({
      success: true,
      data: {
        ...result,
        items: result.items.map(
          ({
            _id,
            name,
            rating,
            text,
            hasImage,
            createdAt,
          }) => ({
            _id,
            name,
            rating,
            text,
            createdAt,
            imageUrl: hasImage
              ? `/api/reviews/${_id}/image`
              : '',
          })
        ),
      },
    });
  });

  // Review images remain private until approval.
  router.get(
    '/reviews/:id/image',
    available,
    async (req, res) => {
      const review = await store.getReviewImage(
        parse(id, req.params.id)
      );

      if (
        !review?.imageData ||
        (
          review.status !== 'approved' &&
          !req.session?.isAdmin
        )
      ) {
        return res.status(404).json({
          success: false,
          message: 'Image not found',
        });
      }

      const image = Buffer.isBuffer(review.imageData)
        ? review.imageData
        : Buffer.from(
            review.imageData.buffer ?? review.imageData
          );

      res
        .set('Cache-Control', 'private, no-store')
        .type(review.imageType)
        .send(image);
    }
  );

  // Submit a review
  router.post(
    '/reviews',
    rateLimit({
      windowMs: 3600000,
      limit: 5,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        success: false,
        message: 'Too many reviews. Please try again later.',
      },
    }),
    available,
    uploadImage,
    async (req, res) => {
      const data = parse(
        z.object({
          name: z.string().trim().min(2).max(80),

          rating: z.coerce
            .number()
            .int()
            .min(1)
            .max(5),

          text: z.string().trim().min(10).max(1500),

          consent: z.literal('true'),
        }),
        req.body
      );

      let image = {};

      if (req.file) {
        const media = await inspectMedia(req.file, {
          imageOnly: true,
        });

        image = {
          hasImage: true,
          imageData: media.buffer,
          imageType: media.mime,
        };
      }

      const saved = await store.createReview({
  ...data,
  consent: true,
  ...image,
  status: 'approved',
});

res.status(201).json({
  success: true,
  data: {
    id: String(saved._id),
    status: 'approved',
  },
  message: 'Thank you! Your review has been published.',
});
    }
  );

  // Anonymous visitor tracking
  router.post(
    '/visits',
    rateLimit({
      windowMs: 60000,
      limit: 30,
      legacyHeaders: false,
      standardHeaders: 'draft-7',
    }),
    available,
    async (req, res) => {
      const settings = await store.getSettings();

      if (!settings.analyticsEnabled) {
        return res.status(204).end();
      }

      const data = parse(
        z
          .object({
            visitorId: z.string().uuid(),

            path: z
              .string()
              .regex(/^\/[a-zA-Z0-9/_-]*$/)
              .max(160),
          })
          .strict(),
        req.body
      );

      const userAgent = req.get('User-Agent') || '';

      const device = /mobile|android|iphone/i.test(userAgent)
        ? 'Mobile'
        : 'Desktop';

      await store.trackVisit({
        visitorKey: createHmac('sha256', secret)
          .update(data.visitorId)
          .digest('hex'),
        path: data.path,
        device,
      });

      res.status(204).end();
    }
  );

  // Protect all admin routes below.
  router.use('/admin', adminGuard, available);

  router.get('/admin/dashboard', async (req, res) => {
    res.json({
      success: true,
      data: await store.dashboard(),
    });
  });

  const contactSchema = z
    .object({
      phone: z
        .string()
        .trim()
        .max(24)
        .regex(/^[+\d ()-]*$/),

      whatsapp: z
        .string()
        .regex(/^\d{10,15}$/)
        .or(z.literal('')),

      email: z
        .string()
        .email()
        .max(160)
        .or(z.literal('')),

      address: z.string().trim().max(500),

      hours: z.string().trim().max(250),

      mapEmbedUrl: z
        .string()
        .max(2000)
        .refine(
          value =>
            !value ||
            /^https:\/\/(www\.)?google\.com\/maps\/embed(?:\?|\/)/.test(
              value
            ),
          'Use a Google Maps embed URL'
        ),

      analyticsEnabled: z.boolean(),

      socialLinks: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(30),

            url: z
              .string()
              .url()
              .max(1000)
              .refine(value => value.startsWith('https://')),
          })
        )
        .max(6),

      stats: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(60),

            value: z
              .number()
              .int()
              .min(0)
              .max(1000000)
              .nullable(),

            suffix: z.string().max(4),
          })
        )
        .length(3),
    })
    .strict();

  router.put('/admin/settings', async (req, res) => {
    const data = parse(contactSchema, req.body);

    res.json({
      success: true,
      data: await store.updateSettings(data),
    });
  });

  // Admin gallery
  router.get('/admin/gallery', async (req, res) => {
    const items = await store.listGallery();

    res.json({
      success: true,
      data: items.map(mediaView),
    });
  });

  // Upload gallery media to Cloudinary.
  router.post(
    '/admin/gallery',
    uploadGallery,
    async (req, res) => {
      const data = parse(
        z
          .object({
            title: z.string().trim().min(2).max(120),

            caption: z
              .string()
              .trim()
              .max(400)
              .default(''),

            serviceId: z
              .string()
              .max(160)
              .default(''),
          })
          .strict(),
        req.body
      );

      if (
        data.serviceId &&
        !services.some(
          service => service.id === data.serviceId
        )
      ) {
        throw Object.assign(
          new Error('Choose a valid service'),
          { status: 400 }
        );
      }

      const media = await inspectMedia(req.file);
      const uploaded = await saveMedia(media);

      let saved;

      try {
        saved = await store.createGallery({
          ...data,
          ...uploaded,
          kind: media.kind,
          mimeType: media.mime,
        });
      } catch (error) {
        // Clean up Cloudinary if saving to MongoDB fails.
        try {
          await removeMedia(uploaded, uploadDir);
        } catch (cleanupError) {
          console.error('Gallery cleanup failed:', {
            publicId: uploaded.publicId,
            message: cleanupError.message,
          });
        }

        throw error;
      }

      res.status(201).json({
        success: true,
        data: mediaView(saved),
      });
    }
  );

  // Reorder gallery media.
  router.patch('/admin/gallery/order', async (req, res) => {
    const data = parse(
      z
        .object({
          ids: z
            .array(id)
            .min(1)
            .max(500)
            .refine(
              ids => new Set(ids).size === ids.length
            ),
        })
        .strict(),
      req.body
    );

    const ordered = await store.orderGallery(data.ids);

    if (!ordered) {
      throw Object.assign(
        new Error('Gallery changed. Refresh and try again.'),
        { status: 409 }
      );
    }

    res.json({
      success: true,
      data: {
        ordered: true,
      },
    });
  });

  // Delete Cloudinary or older local gallery media.
  router.delete(
    '/admin/gallery/:id',
    async (req, res) => {
      const galleryId = parse(id, req.params.id);
      const items = await store.listGallery();

      const item = items.find(
        entry => String(entry._id) === galleryId
      );

      if (!item) {
        return res.status(404).json({
          success: false,
          message: 'Gallery item not found',
        });
      }

      // Retain the record if media deletion fails,
      // allowing the admin to retry.
      await removeMedia(item, uploadDir);
      await store.deleteGallery(galleryId);

      res.json({
        success: true,
        data: {
          deleted: true,
        },
      });
    }
  );

  // Admin reviews
  router.get('/admin/reviews', async (req, res) => {
    const result = await store.listReviews(
      parse(querySchema, req.query)
    );

    res.json({
      success: true,
      data: {
        ...result,
        items: result.items.map(row => ({
          ...row,
          imageUrl: row.hasImage
            ? `/api/reviews/${row._id}/image`
            : '',
        })),
      },
    });
  });

  router.patch(
    '/admin/reviews/:id/status',
    async (req, res) => {
      const data = parse(
        z
          .object({
            status: z.enum([
              'pending',
              'approved',
              'rejected',
            ]),
          })
          .strict(),
        req.body
      );

      const updated = await store.setReviewStatus(
        parse(id, req.params.id),
        data.status
      );

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: 'Review not found',
        });
      }

      res.json({
        success: true,
        data: updated,
      });
    }
  );

  // Admin visitors
  router.get('/admin/visitors', async (req, res) => {
    res.json({
      success: true,
      data: await store.listVisitors(
        parse(querySchema, req.query)
      ),
    });
  });

  // CSV exports
  router.get('/admin/export/:kind', async (req, res) => {
    const query = parse(querySchema, req.query);

    const kind = z
      .enum(['reviews', 'visitors'])
      .parse(req.params.kind);

    const exportQuery = {
      ...query,
      page: 1,
      limit: 10001,
    };

    const result =
      kind === 'reviews'
        ? await store.listReviews(exportQuery)
        : await store.listVisitors(exportQuery);

    if (result.total > 10000) {
      return res.status(422).json({
        success: false,
        message:
          'Narrow the filters to export at most 10,000 rows',
      });
    }

    const headers =
      kind === 'reviews'
        ? ['Date', 'Name', 'Rating', 'Review', 'Status']
        : [
            'First seen',
            'Last seen',
            'Anonymous visitor',
            'Device',
            'Pages',
            'Views',
          ];

    const rows = result.items.map(item =>
      kind === 'reviews'
        ? [
            item.createdAt,
            item.name,
            item.rating,
            item.text,
            item.status,
          ]
        : [
            item.firstSeen,
            item.lastSeen,
            item.visitorKey,
            item.device,
            (item.paths || []).join(' ; '),
            item.views,
          ]
    );

    res
      .set(
        'Content-Disposition',
        `attachment; filename="${kind}.csv"`
      )
      .type('text/csv')
      .send(toCsv(headers, rows));
  });

  return router;
}