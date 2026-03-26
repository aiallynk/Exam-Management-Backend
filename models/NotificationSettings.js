import mongoose from 'mongoose';

const { Schema } = mongoose;

const TenantNotificationSchema = new Schema(
  {
    userRegistration: { type: Boolean, default: true },
    planAlerts: { type: Boolean, default: true },
    backupStatus: { type: Boolean, default: true },
    systemAlerts: { type: Boolean, default: true },
  },
  { _id: false }
);

const ExamCreatorNotificationSchema = new Schema(
  {
    examCreated: { type: Boolean, default: true },
    candidateSubmission: { type: Boolean, default: true },
    resultPublished: { type: Boolean, default: true },
    aiEvaluationCompleted: { type: Boolean, default: true },
  },
  { _id: false }
);

const CandidateNotificationSchema = new Schema(
  {
    examAssigned: { type: Boolean, default: true },
    examReminder: { type: Boolean, default: true },
    resultPublished: { type: Boolean, default: true },
    loginAlerts: { type: Boolean, default: true },
  },
  { _id: false }
);

const NotificationSettingsSchema = new Schema(
  {
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      unique: true,
      index: true,
    },
    notifications: {
      tenant: { type: TenantNotificationSchema, default: () => ({}) },
      examCreator: { type: ExamCreatorNotificationSchema, default: () => ({}) },
      candidate: { type: CandidateNotificationSchema, default: () => ({}) },
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

NotificationSettingsSchema.index({ tenantId: 1 }, { unique: true });

export default mongoose.model('NotificationSettings', NotificationSettingsSchema);
