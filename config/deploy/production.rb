#Somehow we need to get the exact code from UAT
set :branch,        "master"
set :db_host,       "http://10.48.66.17/"
set :db_user,       "stakeout"
set :db_pass,       "Watch0ut"
set :rails_env,     "production"
set :keep_releases, 3

server 'stakeout.tgen.org', :db, :app, :web, :primary => true