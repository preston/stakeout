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
		http_preview: false
	})
end

def create_cloud_dashboard
	domain = 'example.com'
	dash = Dashboard.new(name: 'Cloud Services')
	dash.save!

	(1..2).each do |n|
		Service.create!({
			dashboard: dash,
			name: "Controller #{n}",
			host: "controller0#{n}.#{domain}",
			ping: true,
			http: false,
			http_preview: false
		})
	end

	(1..4).each do |n|
		Service.create!({
			dashboard: dash,
			name: "Node #{n}",
			host: "node0#{n}.#{domain}",
			ping: true,
			http: false,
			http_preview: false
		})
	end
end

create_example_dashboard
create_cloud_dashboard
