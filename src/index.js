 import dns from 'node:dns';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import MongoStore from 'connect-mongo';

import { readEnv } from './config/env.js';
import { createApp } from './app.js';
import { enquiryRepository } from './repositories/enquiries.js';
import { websiteRepository } from './repositories/website.js';
import { Enquiry } from './models/Enquiry.js';
import {
  Settings,
  Gallery,
  Review,
  Visitor,
} from './models/Website.js';

// Configure DNS before connecting to MongoDB Atlas.
dns.setServers(['1.1.1.1', '8.8.8.8']);

try {
  const env = readEnv();

  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });

  console.log('MongoDB connected successfully');

  await Promise.all(
    [Enquiry, Settings, Gallery, Review, Visitor].map(model =>
      model.init()
    )
  );

  const app = createApp({
    ...env,
    repository: enquiryRepository,
    managementRepository: websiteRepository,

    isReady: () => mongoose.connection.readyState === 1,

    sessionStore: MongoStore.create({
      client: mongoose.connection.getClient(),
      collectionName: 'admin_sessions',
    }),
  });

  if (env.production) {
    const build = fileURLToPath(
      new URL('../../client/build/', import.meta.url)
    );

    app.use(express.static(build));

    app.get('/{*path}', (req, res) => {
      res.sendFile(path.join(build, 'index.html'));
    });
  }

  const server = app.listen(env.port, () => {
    console.log(`Abhi API listening on port ${env.port}`);
  });

  async function shutdown() {
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(
    'Startup failed:',
    error.name === 'MongooseServerSelectionError'
      ? 'Cannot connect to MongoDB. Check MONGODB_URI, database availability and network access.'
      : error.message
  );

  process.exit(1);
}