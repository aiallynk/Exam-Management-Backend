# Candidate Mobile API Contract (v1 + Legacy Alias)

## Base Paths
- Primary: `/api/v1`
- Backward-compatible alias: `/api`

All routes below are available under both base paths.

## Authentication
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`

## Candidate Profile
- `GET /candidates/profile`
- `PUT /candidates/profile`
- `GET /candidates/results`

## Exam Discovery
- `GET /exams`
- `GET /exams/:examId`
- `GET /exam-sessions`
- `GET /exam-sessions/:sessionId`
- `GET /exam-sessions/validate/:qrCode`

## Attempt Lifecycle
- `POST /exam-attempts`
- `GET /exam-attempts/:attemptId`
- `GET /exam-attempts/:attemptId/progress`
- `PUT /exam-attempts/:attemptId/progress` (canonical autosave)
- `POST /exam-attempts/:attemptId/answers` (compatibility alias for autosave)
- `POST /exam-attempts/:attemptId/submit`
- `GET /exam-attempts/:attemptId/results`

## Offline Submission
- `POST /exam-attempts/offline-submit`

## Package Download
- `GET /exam-packages/:examId/info`
- `GET /exam-packages/:examId/download`

## Submission Payload Standard

### Progress Save (`PUT /exam-attempts/:attemptId/progress`)
- `answers`: object keyed by `questionId`
- `lastActivity`: ISO timestamp
- `currentSectionId`: optional section id

### Final Submit (`POST /exam-attempts/:attemptId/submit`)
- `answers`: object keyed by `questionId`
- `timerMeta`: optional object
- `clientSubmissionId`: optional idempotency key (recommended for offline sync retries)
- `submissionSource`: optional source label

