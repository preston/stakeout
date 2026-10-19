def create_example_dashboard
  dash = Dashboard.create!(name: 'Example')
  Service.create!({
                    dashboard: dash,
                    name: 'Google',
                    host: 'www.google.com',
                    http: true,
                    https: true,
                    http_preview: true
                  })
  Service.create!({
                    dashboard: dash,
                    name: 'ASU',
                    host: 'www.asu.edu',
                    http: true,
                    https: true,
                    http_preview: true
                  })
  Service.create!({
                    dashboard: dash,
                    name: 'NIH',
                    host: 'nih.gov',
                    http: true,
                    https: false,
                    http_preview: true
                  })
  Service.create!({
                    dashboard: dash,
                    name: 'New York Times',
                    host: 'nytimes.com',
                    http: true,
                    https: false,
                    http_preview: true
                  })
  Service.create!({
                    dashboard: dash,
                    name: 'BBC',
                    host: 'bbc.com',
                    http: true,
                    https: false,
                    http_preview: true
                  })
end

def create_cloud_dashboard
  domain = 'example.com'
  dash = Dashboard.new(name: 'Cloud Services')
  dash.save!

  (1..4).each do |n|
    Service.create!({
                      dashboard: dash,
                      name: "Controller #{n}",
                      host: "controller0#{n}.#{domain}",
                      http: false,
                      http_preview: false
                    })
  end

  (1..4).each do |n|
    Service.create!({
                      dashboard: dash,
                      name: "Node #{n}",
                      host: "node0#{n}.#{domain}",
                      http: false,
                      http_preview: false
                    })
  end
end

create_example_dashboard
create_cloud_dashboard
