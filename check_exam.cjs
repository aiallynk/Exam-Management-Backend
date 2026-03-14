
const mongoose = require('mongoose');

const uri = 'mongodb+srv://aiallynk_db_user:AiAllyPass@exammanagement.nuaz42h.mongodb.net/';

async function check() {
    try {
        await mongoose.connect(uri);
        console.log('Connected to DB');

        const Exam = mongoose.model('Exam', new mongoose.Schema({
            uniqueId: String,
            examCode: String,
            title: String,
            examType: String,
            tenantId: mongoose.Schema.Types.ObjectId
        }));

        const examByUniqueId = await Exam.findOne({ uniqueId: { $regex: /^EXAM-SLOQ-B6V9$/i } });
        console.log('Exam by uniqueId (regex):', JSON.stringify(examByUniqueId, null, 2));

        const examByExamCode = await Exam.findOne({ examCode: { $regex: /^EXAM-SLOQ-B6V9$/i } });
        console.log('Exam by examCode (regex):', JSON.stringify(examByExamCode, null, 2));

        const anyMatch = await Exam.findOne({
            $or: [
                { uniqueId: 'EXAM-SLOQ-B6V9' },
                { examCode: 'EXAM-SLOQ-B6V9' }
            ]
        });
        console.log('Exact match:', !!anyMatch);

        const allExams = await Exam.find().limit(20);
        console.log('All uniqueIds:', allExams.map(e => e.uniqueId || e.examCode || 'N/A'));

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
    }
}

check();
