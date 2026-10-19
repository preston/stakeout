# Stakeout Server

A fantastically simple API service for building self-hosted dashboards for SaaS availability monitoring and automatic screenshots over the HTTP and HTTPS, as well as API-only services. Stakeout is written with Ruby on Rails and PostgreSQL. Screenshots are provided by an instance of a headless Chrome container.

Stakeout Server is designed to be simple, and does not support complex services verification or really anything outside of basic HTTP(S). So if you're looking for Nagios, use Nagios. :)  HTTP Basic authenication for administrative API access is optional, with no other authentication or authorization provided.

Example full service deployment with Docker:

```sh
docker compose -f docker-compose.yml up --pull always --remove-orphans
```

The web interface is provided separately as [Stakeout UI](https://github.com/preston/stakeout-ui)
# Running The Latest Release Images

Start by create a PostgreSQL database and user account and set an environment variable for the connection URL. The server will automatically manage the schema future and future updates. To run the server with docker:


## Run a Browserless Chrome Instance
```sh
# This container captures screenshots via its REST API (POST /screenshot).
docker run -it --rm --name chrome \
  -e "ENABLE_DEBUGGER=false" \
  -e "DISABLE_AUTO_SET_DOWNLOAD_BEHAVIOR=true" \
  -e "DEFAULT_BLOCK_ADS=true" \
  -p 3030:3000 \
  --pull always \
  browserless/chrome:latest
```

## Run Stakeout Server
```sh
docker run -it --rm -p 3000:3000 --name stakeout-server \
	-e "STAKEOUT_SERVER_DATABASE_URL=postgresql://stakeout:password@192.168.1.130:5432/stakeout_development" \
	-e "STAKEOUT_SERVER_CHROME_URL=http://localhost:3030" \
	-e "STAKEOUT_SERVER_USERNAME=stakeout" \
	-e "STAKEOUT_SERVER_PASSWORD=password" \
  -e "STAKEOUT_SERVER_LOG_TO_STDOUT=true" \
	p3000/stakeout-server:latest
```

## Run The Job Worker
Background jobs (e.g. service checks) use Solid Queue and run in a separate process. Start the worker with:

```sh
# From source
bundle exec rake solid_queue:start

# Or via container
docker run -it --rm --name stakeout-worker \
	-e "STAKEOUT_SERVER_DATABASE_URL=postgresql://stakeout:password@192.168.1.130:5432/stakeout_development" \
	-e "STAKEOUT_SERVER_CHROME_URL=http://localhost:3030" \
	-e "STAKEOUT_SERVER_USERNAME=stakeout" \
	-e "STAKEOUT_SERVER_PASSWORD=password" \
  -e "STAKEOUT_SERVER_LOG_TO_STDOUT=true" \
	p3000/stakeout-server:latest bundle exec rake solid_queue:start
```

**macOS:** If the worker segfaults (e.g. in `pg` at `connect_start`), set before starting the worker:
`export PGGSSENCMODE=disable` (avoids GSS/Kerberos-related pg gem crash on arm64)

The app also sets `gssencmode: disable` in `config/database.yml` by default.

# Building Your Own Image


To build a cross-platform version for multiple architectures:

```sh
docker buildx build --platform linux/arm64/v8,linux/amd64 -t p3000/stakeout-server:latest .
```

To build for only your CPU architecture:

```sh
docker build -t p3000/stakeout-server:latest .
```


# Attribution

Copyright © 2011-2026 Preston Lee. All rights reserved.

# License

Provided under the Apache 2.0 license.
