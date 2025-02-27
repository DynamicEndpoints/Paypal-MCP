# Generated by https://smithery.ai. See: https://smithery.ai/docs/config#dockerfile
# Stage 1: Build the TypeScript project
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install

# Copy the rest of the source code
COPY src ./src
COPY tsconfig.json ./

# Build the project
RUN npm run build

# Stage 2: Run the application
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy built files from the builder stage
COPY --from=builder /app/build /app/build
COPY --from=builder /app/node_modules /app/node_modules

# Environment variables (replace these with actual values)
ENV PAYPAL_CLIENT_ID=your_client_id
ENV PAYPAL_CLIENT_SECRET=your_client_secret

# Command to run the MCP server
CMD ["node", "build/index.js"]
