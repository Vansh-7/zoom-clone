FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN useradd --create-home appuser && mkdir /data && chown appuser:appuser /data
USER appuser
ENV DATABASE_URL=sqlite:////data/zoom.db
EXPOSE 8000
CMD ["python", "-m", "app.server", "--host", "0.0.0.0"]
