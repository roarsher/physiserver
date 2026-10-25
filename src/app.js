 import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import { rateLimit } from 'express-rate-limit';

import {
  createHash,
  timingSafeEqual,
  scryptSync,
  randomBytes,
  scrypt,
} from 'node:crypto';

import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  websiteRoutes,
  querySchema,
  parse,
} from './routes/website.js';

import { toCsv } from './utils/csv.js';

// Backend-owned catalogue: works locally and on Render.
const { services, categories } = JSON.parse(
  readFileSync(
    new URL('./data/services.json', import.meta.url),
    'utf8'
  )
);

const digest = value =>
  createHash('sha256').update(value).digest();

const asyncScrypt = promisify(scrypt);

const input = z
  .object({
    name: z.string().trim().min(2).max(80),

    phone: z
      .string()
      .trim()
      .max(24)
      .regex(/^\+?[\d ()-]+$/)
      .transform(
        value =>
          (value.startsWith('+') ? '+' : '') +
          value.replace(/\D/g, '')
      )
      .refine(value => /^\+?\d{10,15}$/.test(value)),

    email: z
      .string()
      .trim()
      .email()
      .max(160)
      .or(z.literal(''))
      .optional()
      .default(''),

    serviceId: z.string().max(160).nullable().optional(),

    requestedFor: z
      .enum(['general', 'appointment', 'free-assessment'])
      .optional()
      .default('general'),

    visitType: z
      .enum(['clinic', 'home'])
      .optional()
      .default('clinic'),

    homeAddress: z
      .string()
      .trim()
      .max(300)
      .optional()
      .default(''),

    message: z
      .string()
      .trim()
      .max(500)
      .optional()
      .default(''),
  })
  .strict();

export function createApp({
  repository,
  managementRepository,
  adminKey,
  adminEmail = 'admin',
  adminPassword = adminKey,
  allowedOrigins = [],
  isReady = () => true,
  trustProxy = false,
  enquiryLimit = 10,
  adminLimit = 300,
  sessionStore,
  production = false,
  sameSite = 'lax',
  uploadDir = fileURLToPath(
    new URL('../uploads/', import.meta.url)
  ),
}) {
  if (!adminKey || adminKey.length < 32) {
    throw Error('A strong admin key is required');
  }

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          frameSrc: [
            "'self'",
            'https://www.google.com',
            'https://maps.google.com',
          ],
          mediaSrc: ["'self'", 'https:', 'blob:'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        },
      },
    })
  );

  // Exact origins come from CLIENT_URLS in your environment.
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({
        success: false,
        message: 'Request origin is not allowed',
      });
    }

    next();
  });

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-Admin-Key'],
    })
  );

  app.use(express.json({ limit: '20kb' }));

  app.use(
    session({
      name: 'abhi.sid',
      secret: adminKey,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: {
        httpOnly: true,
        secure: production,
        sameSite,
        maxAge: 8 * 3600000,
      },
    })
  );

  const salt = randomBytes(16);
  const passwordHash = scryptSync(adminPassword, salt, 64);

  const limit = (count, windowMs) =>
    rateLimit({
      windowMs,
      limit: count,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: {
        success: false,
        message: 'Too many requests. Please try again later.',
      },
    });

  const guard = (req, res, next) => {
    const supplied = req.get('X-Admin-Key') || '';

    const validApiKey = timingSafeEqual(
      digest(supplied),
      digest(adminKey)
    );

    if (!req.session?.isAdmin && !validApiKey) {
      return res.status(401).json({
        success: false,
        message: 'Admin login required',
      });
    }

    res.set('Cache-Control', 'no-store');
    next();
  };

  // Health
  app.get('/api/health', (req, res) => {
    const ready = isReady();

    res.status(ready ? 200 : 503).json({
      success: ready,
      database: ready ? 'connected' : 'unavailable',
    });
  });

  // Public services
  app.get('/api/services', async (req, res) => {
    let media = [];

    if (managementRepository && isReady()) {
      media = await managementRepository.listGallery();
    }

    const items = services.map(service => {
      const linked = media
        .filter(item => item.serviceId === service.id)
        .sort((a, b) => a.sortOrder - b.sortOrder);

      const video = linked.find(item => item.kind === 'video');
      const image = linked.find(item => item.kind === 'image');

      return {
        ...service,

        ...(video
          ? {
              videoUrl: `/uploads/${video.fileName}`,
              previewVideoUrl: `/uploads/${video.fileName}`,
            }
          : {}),

        ...(image
          ? {
              imageUrl: `/uploads/${image.fileName}`,
            }
          : {}),
      };
    });

    res.json({
      success: true,
      data: {
        categories,
        services: items,
      },
    });
  });

  // Public enquiry submission
  app.post(
    '/api/enquiries',
    limit(enquiryLimit, 15 * 60000),
    async (req, res) => {
      if (!isReady()) {
        return res.status(503).json({
          success: false,
          message: 'Enquiries are temporarily unavailable',
        });
      }

      const parsed = input.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          message: 'Check the enquiry fields',
          errors: parsed.error.flatten().fieldErrors,
        });
      }

      const service = parsed.data.serviceId
        ? services.find(
            item => item.id === parsed.data.serviceId
          )
        : null;

      if (parsed.data.serviceId && !service) {
        return res.status(400).json({
          success: false,
          message: 'Choose a valid service',
        });
      }

      const visitType = service?.homeVisit
        ? 'home'
        : parsed.data.visitType;

      if (
        visitType === 'home' &&
        parsed.data.homeAddress.length < 10
      ) {
        return res.status(400).json({
          success: false,
          message: 'Enter your complete home address',
        });
      }

      const saved = await repository.create({
        ...parsed.data,
        visitType,
        homeAddress:
          visitType === 'home'
            ? parsed.data.homeAddress
            : '',
        serviceId: service?.id || null,
        serviceName: service?.name || 'General enquiry',
      });

      res.status(201).json({
        success: true,
        data: {
          id: String(saved._id),
          status: saved.status,
        },
        message: 'Your enquiry has been received',
      });
    }
  );

  // Admin rate limit
  app.use('/api/admin', limit(adminLimit, 15 * 60000));

  // Admin login
  app.post(
    '/api/admin/login',
    limit(10, 15 * 60000),
    async (req, res, next) => {
      const data = parse(
        z
          .object({
            email: z.string().min(1).max(160),
            password: z.string().min(1).max(200),
          })
          .strict(),
        req.body
      );

      const candidate = await asyncScrypt(
        data.password,
        salt,
        64
      );

      const emailMatches = timingSafeEqual(
        digest(data.email.toLowerCase()),
        digest(adminEmail.toLowerCase())
      );

      const passwordMatches = timingSafeEqual(
        candidate,
        passwordHash
      );

      if (!emailMatches || !passwordMatches) {
        return res.status(401).json({
          success: false,
          message: 'Incorrect login details',
        });
      }

      req.session.regenerate(error => {
        if (error) return next(error);

        req.session.isAdmin = true;

        req.session.save(error => {
          if (error) return next(error);

          res.json({
            success: true,
            data: {
              authenticated: true,
            },
          });
        });
      });
    }
  );

  // Admin session
  app.get('/api/admin/session', guard, (req, res) => {
    res.json({
      success: true,
      data: {
        authenticated: true,
      },
    });
  });

  // Admin logout
  app.post('/api/admin/logout', guard, (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);

      res.clearCookie('abhi.sid', {
        httpOnly: true,
        secure: production,
        sameSite,
      });

      res.json({
        success: true,
        data: {
          loggedOut: true,
        },
      });
    });
  });

  // Admin enquiry list
  app.get('/api/admin/enquiries', guard, async (req, res) => {
    if (!isReady()) {
      return res.status(503).json({
        success: false,
        message: 'Database temporarily unavailable',
      });
    }

    const query = parse(querySchema, req.query);

    if (
      query.status &&
      !['new', 'contacted', 'closed'].includes(query.status)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status',
      });
    }

    const { items, total } = await repository.list(query);

    res.json({
      success: true,
      data: {
        items,
        total,
        page: query.page,
        limit: query.limit,
        pages: Math.ceil(total / query.limit),
      },
    });
  });

  // Admin enquiry CSV export
  app.get(
    '/api/admin/enquiries/export',
    guard,
    async (req, res) => {
      const query = parse(querySchema, req.query);

      const result = await repository.list({
        ...query,
        page: 1,
        limit: 10001,
      });

      if (result.total > 10000) {
        return res.status(422).json({
          success: false,
          message: 'Narrow filters to export at most 10,000 rows',
        });
      }

      const csv = toCsv(
        [
          'Date',
          'Name',
          'Phone',
          'Email',
          'Service',
          'Visit',
          'Home address',
          'Message',
          'Status',
        ],
        result.items.map(item => [
          item.createdAt,
          item.name,
          item.phone,
          item.email,
          item.serviceName,
          item.visitType,
          item.homeAddress,
          item.message,
          item.status,
        ])
      );

      res
        .set('Cache-Control', 'no-store')
        .set(
          'Content-Disposition',
          'attachment; filename="enquiries.csv"'
        )
        .type('text/csv')
        .send(csv);
    }
  );

  // Admin enquiry status
  app.patch(
    '/api/admin/enquiries/:id/status',
    guard,
    async (req, res) => {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid enquiry ID',
        });
      }

      const data = parse(
        z
          .object({
            status: z.enum(['new', 'contacted', 'closed']),
          })
          .strict(),
        req.body
      );

      const updated = await repository.setStatus(
        req.params.id,
        data.status
      );

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: 'Enquiry not found',
        });
      }

      res.json({
        success: true,
        data: updated,
      });
    }
  );

  // Settings, gallery, reviews and visitor routes
  if (managementRepository) {
    app.use(
      '/api',
      websiteRoutes({
        store: managementRepository,
        services,
        adminGuard: guard,
        uploadDir,
        secret: adminKey,
        ready: isReady,
      })
    );
  }

  // Uploaded media
  app.use(
    '/uploads',
    express.static(uploadDir, {
      dotfiles: 'deny',
      index: false,
      fallthrough: false,
      setHeaders: res => {
        res.set('X-Content-Type-Options', 'nosniff');
      },
    })
  );

  // Unknown API route
  app.use('/api', (req, res) => {
    res.status(404).json({
      success: false,
      message: 'API endpoint not found',
    });
  });

  // Error handler
  app.use((error, req, res, next) => {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message:
          'File is too large (review images: 5 MB; gallery: 50 MB)',
      });
    }

    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        success: false,
        message: 'Request is too large',
      });
    }

    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({
        success: false,
        message: 'Invalid JSON',
      });
    }

    const status =
      error.status ||
      (error.name === 'ZodError' || error.name === 'MulterError'
        ? 400
        : 500);

    if (status >= 500) {
      console.error('API request failed:', error.name);
    }

    res.status(status).json({
      success: false,
      message:
        status >= 500
          ? 'Unable to process the request. Please try again later.'
          : error.message,
    });
  });

  return app;
}