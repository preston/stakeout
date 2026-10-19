json.message 'This application server and underlying database connection appear to be healthy.'
json.server do
    json.datetime Time.now
end
json.database do
    # json.datetime Time.parse(ActiveRecord::Base.connection.select_value('SELECT CURRENT_TIMESTAMP')).to_s
    json.datetime ActiveRecord::Base.connection.select_value('SELECT CURRENT_TIMESTAMP')
end
