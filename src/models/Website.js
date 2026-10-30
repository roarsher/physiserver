 import mongoose from 'mongoose';

const { Schema } = mongoose;

export const Settings = mongoose.model(
  'WebsiteSettings',
  new Schema(
    {
      key: {
        type: String,
        unique: true,
        default: 'public',
      },

      data: {
        type: Schema.Types.Mixed,
        default: {},
      },
    },
    { timestamps: true }
  )
);

export const Gallery = mongoose.model(
  'GalleryMedia',
  new Schema(
    {
      title: {
        type: String,
        required: true,
      },

      caption: {
        type: String,
        default: '',
      },

      kind: {
        type: String,
        enum: ['image', 'video'],
        required: true,
      },

      storage: {
        type: String,
        enum: ['local', 'cloudinary'],
        default: 'local',
      },

      // Retained for older local uploads.
      fileName: {
        type: String,
        default: '',
      },

      url: {
        type: String,
        default: '',
      },

      publicId: {
        type: String,
        default: '',
      },

      resourceType: {
        type: String,
        enum: ['image', 'video'],
      },

      mimeType: String,

      serviceId: {
        type: String,
        default: '',
      },

      sortOrder: {
        type: Number,
        default: 0,
      },
    },
    { timestamps: true }
  )
);

export const Review = mongoose.model(
  'Review',
  new Schema(
    {
      name: {
        type: String,
        required: true,
      },

      rating: {
        type: Number,
        min: 1,
        max: 5,
        required: true,
      },

      text: {
        type: String,
        required: true,
      },

      status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
      },

      hasImage: {
        type: Boolean,
        default: false,
      },

      imageData: {
        type: Buffer,
        select: false,
      },

      imageType: String,

      consent: {
        type: Boolean,
        required: true,
      },
    },
    { timestamps: true }
  )
);

const visitorSchema = new Schema(
  {
    visitorKey: {
      type: String,
      required: true,
    },

    day: {
      type: String,
      required: true,
    },

    paths: [String],

    views: {
      type: Number,
      default: 0,
    },

    device: String,
    firstSeen: Date,
    lastSeen: Date,
    expiresAt: Date,
  },
  { versionKey: false }
);

visitorSchema.index(
  { visitorKey: 1, day: 1 },
  { unique: true }
);

visitorSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

export const Visitor = mongoose.model(
  'Visitor',
  visitorSchema
);