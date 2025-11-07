# Server Application

## Scripts

- `npm start` – start the server in production mode
- `npm run dev` – start the server with file watching for local development
- `npm run seed` – run the optional database seed script (if implemented)

## Environment Variables

Copy `env.example` to `.env` and configure:

- `PORT` – Port to run the API server (default `4000`)
- `MONGODB_URI` – MongoDB connection string
- `JWT_SECRET` / `JWT_REFRESH_SECRET` – Secrets for signing access/refresh tokens
- `TOKEN_TTL_MINUTES` / `REFRESH_TTL_DAYS` – Token expiration configuration
- `CORS_ORIGIN` – Allowed origin for the client application
- `OPENAI_API_KEY` – (Optional) key for AI-powered features
- `UPLOAD_DIR` – Directory to store uploaded files (defaults to `./uploads`)

## Deployment

1. Run `npm install` to install dependencies.
2. Configure environment variables in your hosting platform using `env.example` as a reference.
3. Ensure MongoDB is accessible from your hosting provider.
4. Start the server with `npm start` or your platform's process manager.

Expose the `/health` endpoint for health checks if your provider supports them.


