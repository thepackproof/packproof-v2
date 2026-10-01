# Reference CPU runtime. Pin the resolved base/image digest before a qualification run.
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
WORKDIR /worker
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.lock \
    && groupadd --gid 10001 surface \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin surface
COPY packproof_surface ./packproof_surface
COPY profiles ./profiles
USER 10001:10001
ENTRYPOINT ["python", "-m", "packproof_surface"]
