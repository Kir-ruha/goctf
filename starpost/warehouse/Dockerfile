FROM python:3.12-alpine
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY worker.py /app/worker.py
CMD ["python", "/app/worker.py"]
