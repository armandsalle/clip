# Planche de vignettes : ffmpeg extrait une image toutes les N secondes et les
# assemble en une grille (aperçu au survol de la timeline).
FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir fastapi==0.120.0 uvicorn==0.38.0
WORKDIR /app
COPY server.py .
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
