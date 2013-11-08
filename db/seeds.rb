# This file should contain all the record creation needed to seed the database with its default values.
# The data can then be loaded with the rake db:seed (or created alongside the db with db:setup).
#
# Examples:
#
#   cities = City.create([{ name: 'Chicago' }, { name: 'Copenhagen' }])
#   Mayor.create(name: 'Emanuel', city: cities.first)



def create_example_dashboard
	dash = Dashboard.create!(name: 'Example')
	Service.create!({
		dashboard: dash,
		name: "Google",
		host: "www.google.com",
		ping: true,
		http: true,
		https: true,
		http_preview: true
	})
	Service.create!({
		dashboard: dash,
		name: "ASU",
		host: "www.asu.edu",
		ping: true,
		http: true,
		https: true,
		http_preview: true
	})
	Service.create!({
		dashboard: dash,
		name: "NIH",
		host: "nih.gov",
		ping: false,
		http: true,
		https: false,
		http_preview: true
	})
	Service.create!({
		dashboard: dash,
		name: "New York Times",
		host: "nytimes.com",
		ping: false,
		http: true,
		https: false,
		http_preview: true
	})
	Service.create!({
		dashboard: dash,
		name: "BBC",
		host: "bbc.co.uk",
		ping: false,
		http: true,
		https: false,
		http_preview: true
	})
end


create_example_dashboard
