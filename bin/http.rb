#!/usr/bin/env ruby

require 'capybara'
require 'capybara/poltergeist'

opts  = {
  :x => 0,          # top left position
  :y => 0,
  :w => 1280,       # bottom right position
  :h => 1024,

  :wait => 0.5,     # if selector is nil, wait 1 seconds before taking the screenshot
  :selector => nil  # wait until the selector matches to take the screenshot
}

b = Capybara::Session.new :poltergeist
b.visit 'http://www.google.com'
sleep 1

# tmp = Tempfile.new(['photograph','.png'])
tmp = File.open('/tmp/photograph.png')
puts tmp.path

b.driver.render tmp.path,
  :width  => opts[:w] + opts[:x],
  :height => opts[:h] + opts[:y]
