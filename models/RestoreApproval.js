import mongoose from 'mongoose';
const RestoreApprovalSchema = new mongoose.Schema({
  restoreId: { type: mongoose.Schema.Types.ObjectId, ref: 'RestoreRecord', required: true, unique: true }, requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, requiredApproverRole: { type: String, required: true }, approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'], default: 'PENDING' }, comments: { type: String, default: '' }, requestedAt: { type: Date, default: Date.now }, approvedAt: Date, expiresAt: Date,
}, { timestamps: true, collection: 'restore_approvals' });
export default mongoose.model('RestoreApproval', RestoreApprovalSchema);
