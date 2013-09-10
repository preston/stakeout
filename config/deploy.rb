set :stages, [:production, :uat]
set :default_stage, "production"
set :application, "stakeout"

require 'capistrano/ext/multistage'
require 'rvm/capistrano'
require "bundler/capistrano"

set :rvm_type,              :system
set :rvm_ruby_string,       "ruby-2.0.0"
set :rvm_path,              "/usr/local/rvm"

# set :bundle_flags, "--binstubs"

# set :user,  "apache"
# set :group, "apache"

role :web, "10.48.66.17"                          # Your HTTP server, Apache/etc
role :app, "10.48.66.17"                          # This may be the same as your `Web` server
role :db,  "10.48.66.17", :primary => true        # This is where Rails migrations will run


set :scm, :git
set :repository, "git@github.com:preston/stakeout.git"
set :deploy_to, "/var/www/#{application}"
set :deploy_env, 'production'


set :use_sudo,    false
set :deploy_via, 'copy'
set :copy_exclude, ['.git']
set :user,      "apache"

after "deploy", "deploy:migrate"
after "deploy:migrate", 'deploy:cleanup'
before "deploy:assets:precompile", "config:update"

default_run_options[:pty] = true
set :ssh_options, { :forward_agent => true }
# ssh_options[:forward_agent] = true


namespace :deploy do
  task :start do ; end
  task :stop do ; end
  task :restart, :roles => :app, :except => { :no_release => true } do
    #unicorn via upstart
    run "touch #{release_path}/tmp/restart.txt"
  end
end


# Custom stuff.
namespace :config do
 
  desc "Add server-only shared directories."
  task :setup, :roles => [:app] do
    run "mkdir -p #{shared_path}/config"
  end
  after "deploy:setup", "config:setup"
  
  desc "Update server-only config files to new deployment directory."
  task :update, :roles => [:app] do
    run "cp -Rfv #{shared_path}/config #{release_path}"
    # run "cp -Rfv #{shared_path}/public/data #{release_path}/public/"
    run "ln -s #{shared_path}/public/data #{release_path}/public/data"
  end
end
