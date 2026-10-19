json.extract! service, :id, :dashboard_id, :name, :host, :port, :http, :https,
              :http_path, :http_path_last, :https_path_last, :http_xquery, :http_xquery_last, :http_preview,
              :checked_at, :created_at, :updated_at

if @with_screenshots
  # puts "WITH SCREENSHOTS"
  json.http_screenshot service.http_screenshot ? Base64.encode64(service.http_screenshot) : nil
end
# json.asset_available service.asset.attached?

json.path dashboard_service_path(service.dashboard, service)
json.url dashboard_service_url(service.dashboard, service)
