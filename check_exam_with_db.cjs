
const mongoose = require('mongoose');

const uri = 'mongodb+srv://aiallynk_db_user:AiAllyPass@exammanagement.nuaz42h.mongodb.net/';

async function check() {
    try {
        await mongoose.connect(uri, { dbName: 'exam_system' });
        console.log('Connected to DB');

        const Exam = mongoose.model('Exam', new mongoose.Schema({
            uniqueId: String,
            examCode: String,
            title: String,
            examType: String,
            tenantId: mongoose.Schema.Types.ObjectId
        }));

        const examByUniqueId = await Exam.findOne({ uniqueId: 'EXAM-SLOQ-B6V9' });
        console.log('Exam by uniqueId:', !!examByUniqueId);

        const examByExamCode = await Exam.findOne({ examCode: 'EXAM-SLOQ-B6V9' });
        console.log('Exam by examCode:', !!examByExamCode);

        const allExams = await Exam.find().limit(5);
        console.log('Sample exams (uniqueIds):', allExams.map(e => ({ title: e.title, uniqueId: e.uniqueId, examCode: e.examCode })));

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
    }
}

check();
