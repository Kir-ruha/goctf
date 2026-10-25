FROM python:3.12-slim
WORKDIR /greenhouse
COPY native/greenhouse-console /greenhouse/greenhouse-console
COPY app/ /greenhouse/app/
COPY frontend/ /greenhouse/frontend/
COPY start.sh /greenhouse/start.sh
RUN chmod +x /greenhouse/greenhouse-console /greenhouse/start.sh && mkdir -p /data && useradd -m -u 10001 greenhouse && chown greenhouse:greenhouse /data
USER greenhouse
ENV GREENHOUSE_DATA=/data PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["/greenhouse/start.sh"]
