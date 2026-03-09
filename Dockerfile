FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt requests

COPY bambu_mqtt.py filament_tracker.py get_credentials.py ./
COPY templates/ templates/
COPY static/ static/
COPY config.example.py .

RUN useradd -m -u 1000 app

ENV FILAMENT_TRACKER_DATA_DIR=/app/data
RUN mkdir -p /app/data && chown app:app /app/data
VOLUME /app/data

USER app

EXPOSE 5000

CMD ["python3", "filament_tracker.py", "--port", "5000"]
