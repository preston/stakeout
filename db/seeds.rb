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

def create_cloud_dashboard
	domain = 'example.com'
	dash = Dashboard.new(name: 'Cloud Services')
	dash.save!

	Service.create!({
		dashboard: dash,
		name: "Controller #{n}",
		host: "controller0#{n}.#{domain}",
		ping: true,
		http: false,
		http_preview: false
	})

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

