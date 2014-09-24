source 'https://rubygems.org'
ruby '2.1.3'

gem 'rails', '4.1.6'
gem 'sass-rails', '~> 4.0.3'
gem 'uglifier', '>= 1.3.0'

# gem 'turbolinks'

# Twitter bootstrap layout.
gem "therubyracer"
gem "less-rails"
gem 'twitter-bootstrap-rails'

# Templating
gem 'slim-rails'

gem 'jquery-rails'
gem 'jquery-ui-rails'
gem 'pdfkit'

# Service-checking stuff.
gem 'net-ping'		# ICMP pings.
gem 'poltergeist'	# HTTP screenshots!

group :development do
	gem 'sqlite3'
	gem 'capistrano' #, '>= 3.0.1'
	gem 'capistrano-rvm'
	gem 'capistrano-bundler'
	gem 'capistrano-rails'
	gem 'railroady'

	gem 'byebug'
	# gem	'binding_of_caller'
	# gem 'better_errors'
end

group :production do
	gem 'pg'
end

group :doc do
  # bundle exec rake doc:rails generates the API under doc/api.
  gem 'sdoc', require: false
end