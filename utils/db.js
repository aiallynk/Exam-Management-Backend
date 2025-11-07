import mongoose from 'mongoose';
import config from '../config/env.js';

export const connect = async () => {
  try {
    await mongoose.connect(config.mongodbUri, {
      dbName: 'exam_system',
    });
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

export const disconnect = async () => {
  try {
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
  } catch (error) {
    console.error('MongoDB disconnection error:', error);
  }
};

