FROM ruby:4.0.6-slim
LABEL maintainer="preston.lee@prestonlee.com"

# RUN apt-get update && apt-get dist-upgrade -y && apt-get install -y build-essential imagemagick
# Install postgres native client package and native image processing
RUN apt-get update && apt-get install -y build-essential libpq-dev libyaml-dev imagemagick

# Default shell as bash
RUN rm /bin/sh && ln -s /bin/bash /bin/sh


# Configure the main working directory. This is the base
# directory used in any further RUN, COPY, and ENTRYPOINT
# commands.
RUN mkdir -p /app
WORKDIR /app

# Copy the Gemfile as well as the Gemfile.lock and install
# the RubyGems. This is a separate step so the dependencies
# will be cached unless changes to one of those two files
# are made.
COPY Gemfile Gemfile.lock Rakefile config.ru ./
RUN gem install -N bundler && bundle install --jobs 8

# Copy the main application.
COPY . .

# We'll run in production mode by default.
ENV RAILS_ENV=production

# Showtime!
EXPOSE 3000
# CMD bundle exec rake db:migrate && bundle exec puma -C config/puma.rb
CMD bundle exec rake db:migrate && rails s
