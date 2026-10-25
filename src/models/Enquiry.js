 import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    email: {
      type: String,
      trim: true,
      maxlength: 160,
      default: '',
    },

    phone: {
      type: String,
      required: true,
      maxlength: 16,
    },

    serviceId: {
      type: String,
      default: null,
    },

    serviceName: {
      type: String,
      required: true,
      maxlength: 150,
    },

    requestedFor: {
      type: String,
      enum: ['general', 'appointment', 'free-assessment'],
      default: 'general',
    },

    visitType: {
      type: String,
      enum: ['clinic', 'home'],
      default: 'clinic',
    },

    homeAddress: {
      type: String,
      trim: true,
      maxlength: 300,
      default: '',
      required: function () {
        return this.visitType === 'home';
      },
    },

    message: {
      type: String,
      default: '',
      maxlength: 500,
    },

    status: {
      type: String,
      enum: ['new', 'contacted', 'closed'],
      default: 'new',
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

schema.index({ status: 1, createdAt: -1 });
schema.index({ createdAt: -1 });

export const Enquiry = mongoose.model('Enquiry', schema);