FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies first (for better caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the application
COPY src/ ./src/

# Start the bot
CMD ["npm", "start"]
