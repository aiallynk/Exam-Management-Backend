import mongoose from 'mongoose';

const LanguageSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 10,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    nativeName: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Only one default language allowed
LanguageSchema.pre('save', async function (next) {
  if (this.isDefault) {
    await mongoose.model('Language').updateMany(
      { _id: { $ne: this._id } },
      { $set: { isDefault: false } }
    );
  }
  next();
});

LanguageSchema.index({ isActive: 1, isDefault: 1 });

export default mongoose.model('Language', LanguageSchema);
