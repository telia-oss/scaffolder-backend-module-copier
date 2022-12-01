FROM python:3.7-slim
WORKDIR /usr/src/app
RUN apt-get update && apt-get -y install python3-venv git apt-transport-https ca-certificates curl gnupg2 \
software-properties-common sudo gpg-agent tzdata yamllint
RUN groupadd --gid 1000 casf-builder \
&& useradd --gid 1000 --uid 1000 --create-home casf-builder && groupadd --gid 999 docker \
&& usermod -a -G sudo,docker casf-builder \
&& echo "casf-builder ALL=(ALL:ALL) NOPASSWD:ALL" >> /etc/sudoers
COPY requirements.txt .
RUN python3 -m pip install -r requirements.txt
RUN pip uninstall -y pipx
USER casf-builder
RUN pip install pipx
ENV PATH $PATH:/home/casf-builder/.local/bin
RUN pipx install copier && pipx inject copier "MarkupSafe<2.1.0" && pipx inject copier jinja2-time

