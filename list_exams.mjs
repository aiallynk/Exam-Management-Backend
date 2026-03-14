import mongoose from 'mongoose';
import Exam from './models/Exam.js';
import dotenv from 'dotenv';
dotenv.config();

async function listExams() {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: 'exam_system' });
    const exams = await Exam.find({}).limit(5);
    console.log(JSON.stringify(exams.map(e => ({ id: e._id, uniqueId: e.uniqueId, title: e.title })), null, 2));
    await mongoose.disconnect();
}

listExams();
