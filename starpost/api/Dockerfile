FROM python:3.12-alpine

RUN apk add --no-cache ttf-dejavu
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY *.py /app/
WORKDIR /app
CMD ["gunicorn", "--preload", "--workers", "2", "--threads", "4", "--bind", "0.0.0.0:5000", "app:app"]
