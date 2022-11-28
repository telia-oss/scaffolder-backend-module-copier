FROM python:3.7-alpine
WORKDIR /usr/src/app
COPY requirements.txt .
RUN apk update && apk add build-base git
RUN python3 -m pip install -r requirements.txt
RUN pipx install copier && pipx inject copier "MarkupSafe<2.1.0" && pipx inject copier jinja2-time
ENV PATH $PATH:/root/.local/bin
