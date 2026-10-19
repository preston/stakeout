json.extract! dashboard, :id, :name, :created_at, :updated_at

json.path dashboard_path(dashboard)
json.url dashboard_url(dashboard)
