FROM python:3.11-slim

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean

# Set up the app directory
WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all your code files
COPY . .

# Expose the port Render uses
EXPOSE 10000

# Command to run the app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10000"]